require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  await prisma.centre.createMany({
    data: [
      { name: 'Bilaspur Mandi Centre 1', location: 'Bilaspur', capacity: 40 },
      { name: 'Bilaspur Mandi Centre 2', location: 'Bilaspur', capacity: 40 },
      { name: 'Takhatpur Procurement Centre', location: 'Takhatpur', capacity: 30 },
    ]
  });
  console.log('Centres added!');
}
main().then(() => prisma.$disconnect());