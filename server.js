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

app.post('/api/bookings', async (req, res) => {
  const { farmerId, centreId, crop, quantity, date, slot } = req.body;
  const booking = await prisma.booking.create({
    data: { farmerId, centreId, crop, quantity, date: new Date(date), slot }
  });
  res.json(booking);
});
app.patch('/api/bookings/:id/status', async (req, res) => {
  try {
    const { status } = req.body; // 'pending' | 'progress' | 'done'
    const booking = await prisma.booking.update({
      where: { id: Number(req.params.id) },
      data: { status }
    });
    res.json(booking);
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
app.get('/api/farmers/:id/bookings', async (req, res) => {
  const bookings = await prisma.booking.findMany({
    where: { farmerId: Number(req.params.id) },
    include: { centre: true, payment: true },
    orderBy: { createdAt: 'desc' }
  });
  res.json(bookings);
});

app.get('/api/admin/bookings', async (req, res) => {
  const bookings = await prisma.booking.findMany({
    include: { farmer: true, centre: true, payment: true },
    orderBy: { date: 'asc' }
  });
  res.json(bookings);
});

app.listen(process.env.PORT, () => console.log(`Server running on port ${process.env.PORT}`));