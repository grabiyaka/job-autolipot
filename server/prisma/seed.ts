import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { backfillReadingTransactions } from '../framework/composition/backfill-reading-transactions.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required to seed demo subscribers.');

const database = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

try {
  // Restarting the demo must not reset balances, versions or submitted readings.
  await database.subscriber.createMany({
    skipDuplicates: true,
    data: [
      {
        id: 'demo-subscriber-1',
        accountNumber: 'DEMO-001',
        displayName: 'Демонстрационный абонент № 1',
        villageName: 'Демо-село',
        meterNumber: 'DEMO-METER-001',
        readingHundredths: 150183,
        balanceKopeks: -5000,
        waterTariffKopeks: 1000,
        drainageTariffKopeks: 200,
        hasWater: true,
        hasDrainage: true,
      },
      {
        id: 'demo-subscriber-2',
        accountNumber: 'DEMO-002',
        displayName: 'Демонстрационный абонент № 2',
        villageName: 'Демо-село',
        meterNumber: 'DEMO-METER-002',
        readingHundredths: 43210,
        balanceKopeks: 10000,
        waterTariffKopeks: 1000,
        drainageTariffKopeks: 200,
        hasWater: true,
        hasDrainage: false,
      },
      {
        id: 'demo-subscriber-3',
        accountNumber: 'DEMO-003',
        displayName: 'Демонстрационный абонент № 3',
        villageName: 'Демо-село',
        meterNumber: 'DEMO-METER-003',
        readingHundredths: 20000,
        balanceKopeks: 0,
        waterTariffKopeks: 1000,
        drainageTariffKopeks: 200,
        hasWater: false,
        hasDrainage: false,
      },
      {
        id: 'demo-subscriber-4',
        accountNumber: 'DEMO-004',
        displayName: 'Демонстрационный абонент № 4',
        villageName: 'Демо-село',
        meterNumber: 'DEMO-METER-004',
        readingHundredths: 10000,
        balanceKopeks: -10000,
        maintenanceBalanceKopeks: -1500,
        waterTariffKopeks: 3000,
        drainageTariffKopeks: 1500,
        hasWater: true,
        hasDrainage: true,
      },
    ],
  });
  const linkedReadings = await backfillReadingTransactions(database);
  console.info('Demo subscribers are ready; existing account state was preserved.');
  console.info(`Existing reading evidence linked to the transaction journal: ${linkedReadings}.`);
} finally {
  await database.$disconnect();
}
