require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

async function notify(farmerId, message) {
  try {
    await prisma.notification.create({ data: { farmerId, message } });
  } catch (err) {
    console.error('Notification error:', err);
  }
}

app.post('/api/auth/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ error: 'Invalid phone number' });

  const otp = String(Math.floor(1000 + Math.random() * 9000));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await prisma.otpRequest.create({ data: { phone, otp, expiresAt } });

  console.log(`OTP for ${phone}: ${otp}`);
  res.json({ message: 'OTP sent', devOtp: otp });
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const { phone, otp } = req.body;
  const record = await prisma.otpRequest.findFirst({
    where: { phone, otp, verified: false },
    orderBy: { id: 'desc' }
  });
  if (!record || record.expiresAt < new Date()) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }
  await prisma.otpRequest.update({ where: { id: record.id }, data: { verified: true } });

  let farmer = await prisma.farmer.findUnique({ where: { phone } });
  if (!farmer) farmer = await prisma.farmer.create({ data: { phone } });

  res.json({ farmer });
});

app.get('/api/availability', async (req, res) => {
  try {
    const { centreId, date, slot } = req.query;
    const centre = await prisma.centre.findUnique({ where: { id: Number(centreId) } });
    if (!centre) return res.status(404).json({ error: 'Centre not found' });
    const count = await prisma.booking.count({
      where: { centreId: Number(centreId), date: new Date(date), slot: slot, status: { notIn: ['done', 'cancelled'] } }
    });
    res.json({ capacity: centre.capacity, booked: count, remaining: Math.max(centre.capacity - count, 0) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bookings', async (req, res) => {
  try {
    const { farmerId, centreId, crop, quantity, date, slot } = req.body;

    const centre = await prisma.centre.findUnique({ where: { id: Number(centreId) } });
    if (!centre) return res.status(404).json({ error: 'Centre not found' });

    const existingCount = await prisma.booking.count({
      where: { centreId: Number(centreId), date: new Date(date), slot: slot, status: { notIn: ['done', 'cancelled'] } }
    });
    if (existingCount >= centre.capacity) {
      return res.status(400).json({ error: 'This slot is full. Please choose another date or time.' });
    }

    const booking = await prisma.booking.create({
      data: { farmerId, centreId, crop, quantity, date: new Date(date), slot }
    });

    await notify(farmerId, 'Booking confirmed: ' + crop + ' on ' + date + ' (' + slot + ') at ' + centre.name + '. Token #' + String(booking.id).padStart(6,'0') + '.');

    res.json(booking);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/farmers/:id/bookings', async (req, res) => {
  try {
    const farmerId = Number(req.params.id);
    const bookings = await prisma.booking.findMany({
      where: { farmerId: farmerId },
      include: { centre: true, payment: true },
      orderBy: { createdAt: 'desc' }
    });

    const withPosition = await Promise.all(bookings.map(async function(b){
      if (b.status === 'done' || b.status === 'cancelled') {
        return Object.assign({}, b, { queuePosition: null, queueTotal: null });
      }
      const group = await prisma.booking.findMany({
        where: {
          centreId: b.centreId,
          date: b.date,
          slot: b.slot,
          status: { notIn: ['done', 'cancelled'] }
        },
        orderBy: { createdAt: 'asc' }
      });
      let position = 0;
      for (let i = 0; i < group.length; i++) {
        if (group[i].id === b.id) { position = i + 1; break; }
      }
      return Object.assign({}, b, { queuePosition: position, queueTotal: group.length });
    }));

    res.json(withPosition);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/bookings', async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({
      include: { farmer: true, centre: true, payment: true },
      orderBy: { date: 'asc' }
    });
    res.json(bookings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/bookings/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const booking = await prisma.booking.update({
      where: { id: Number(req.params.id) },
      data: { status: status }
    });
    if (status === 'progress') {
      await notify(booking.farmerId, 'Your token #' + String(booking.id).padStart(6,'0') + ' is now In Queue at the centre.');
    } else if (status === 'done') {
      await notify(booking.farmerId, 'Your crop for token #' + String(booking.id).padStart(6,'0') + ' has been Procured. Thank you!');
    } else if (status === 'cancelled') {
      await notify(booking.farmerId, 'Your booking token #' + String(booking.id).padStart(6,'0') + ' has been cancelled.');
    }
    res.json(booking);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/bookings/:id/payment', async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    const existing = await prisma.payment.findUnique({ where: { bookingId: bookingId } });
    let payment;
    if (existing) {
      payment = await prisma.payment.update({
        where: { bookingId: bookingId },
        data: { status: 'paid', paidAt: new Date() }
      });
    } else {
      payment = await prisma.payment.create({
        data: { bookingId: bookingId, status: 'paid', paidAt: new Date() }
      });
    }
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (booking) {
      await notify(booking.farmerId, 'Payment for token #' + String(bookingId).padStart(6,'0') + ' has been marked as Paid.');
    }
    res.json(payment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/bookings/:id', async (req, res) => {
  try {
    await prisma.booking.delete({ where: { id: Number(req.params.id) } });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/farmers/:id/notifications', async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { farmerId: Number(req.params.id) },
      orderBy: { createdAt: 'desc' }
    });
    res.json(notifications);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT, () => console.log('Server running on port ' + process.env.PORT));