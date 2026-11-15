/**
 * src/cli.js
 * Operator CLI for ACTION Kinoquiz WhatsApp Bot
 *
 * Provides utility commands for the organizer:
 * - `node src/cli.js stats` : Displays database statistics (bookings, teams, captains)
 * - `node src/cli.js export-csv` : Generates a fresh CSV file of all bookings
 * - `node src/cli.js list-games` : Displays active upcoming games parsed from Instagram/catalog
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { initDatabase } from './db/database.js';
import { exportBookingsCsv } from './db/exportCsv.js';
import { getActiveGames } from './games/gameLoader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const botRootDir = path.resolve(__dirname, '..');

const command = process.argv[2] || 'help';
const db = initDatabase(config.dbPath);

async function run() {
  switch (command) {
    case 'stats': {
      const bookings = db.bookings.list({ limit: 1000 });
      const teams = db.teams.list();
      const contacts = db.contacts.list({ limit: 1000 });

      console.log('═══════════════════════════════════════════════');
      console.log('🎬 ACTION Киноквиз Караганда — База Данных');
      console.log('═══════════════════════════════════════════════');
      console.log(`📌 Всего броней:     ${bookings.length}`);
      console.log(`👥 Уникальных команд: ${teams.length}`);
      console.log(`📱 Капитанов в базе:  ${contacts.length}`);
      console.log(`📂 Путь к базе SQLite: ${config.dbPath}`);
      console.log('═══════════════════════════════════════════════');
      break;
    }

    case 'export-csv': {
      console.log('Экспорт броней в CSV...');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filePath = path.join(config.exportDir, `bookings_${timestamp}.csv`);
      const csvContent = await exportBookingsCsv(db, filePath);
      const lines = csvContent.trim().split('\n').length - 1;
      console.log(`✅ Успешно экспортировано: ${lines} броней`);
      console.log(`📁 Файл сохранен: ${filePath}`);
      break;
    }

    case 'list-games': {
      console.log('Синхронизация актуальных игр...');
      const games = getActiveGames(botRootDir);
      console.log(`Найдено активных игр: ${games.length}\n`);
      games.forEach((g, idx) => {
        console.log(`${idx + 1}. [${g.dateStr || 'Вторник 19:30'}] ${g.title}`);
        if (g.description) console.log(`   ${g.description}`);
      });
      break;
    }

    default:
      console.log('Использование: node src/cli.js <команда>');
      console.log('Доступные команды:');
      console.log('  stats       - Показать статистику броней и контактов');
      console.log('  export-csv  - Экспортировать все брони в файл CSV');
      console.log('  list-games  - Показать список активных игр из каталога');
      break;
  }

  db.close();
}

run().catch((err) => {
  console.error('Ошибка CLI:', err);
  process.exit(1);
});
