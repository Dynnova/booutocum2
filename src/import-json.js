// ============================================================
// SCRIPT 2: Import JSON hasil scrape ke SQLite DB
// Usage: node src/import-json.js <path-to-json>
// ============================================================

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { upsertCosplay, getStats } = require('./database');

const file = process.argv[2];

if (!file) {
  console.error('Usage: node src/import-json.js <path-to-json>');
  console.error('Contoh: node src/import-json.js mitaku-FULL-7000posts.json');
  process.exit(1);
}

if (!fs.existsSync(file)) {
  console.error(`❌ File tidak ditemukan: ${file}`);
  process.exit(1);
}

console.log(`📂 Membaca: ${file}`);
const raw  = fs.readFileSync(file, 'utf8');
const data = JSON.parse(raw);

console.log(`📦 Total records: ${data.length}`);
console.log('💾 Importing ke DB...\n');

let saved = 0;
let skipped = 0;
let failed = 0;

for (const item of data) {
  try {
    if (!item.page_url) { skipped++; continue; }

    upsertCosplay({
      title:      item.title      || '',
      cover_url:  item.cover_url  || '',
      page_url:   item.page_url,
      image_urls: item.image_urls?.length
        ? JSON.stringify(item.image_urls)
        : null,
      created_at: new Date().toISOString(),
    });

    saved++;

    if (saved % 100 === 0) {
      process.stdout.write(`\r💾 ${saved}/${data.length} imported...`);
    }
  } catch(e) {
    failed++;
    console.error(`\n❌ Gagal import: ${item.page_url} → ${e.message}`);
  }
}

console.log(`\n\n${'─'.repeat(50)}`);
console.log(`✅ Selesai!`);
console.log(`💾 Imported : ${saved}`);
console.log(`⏭️  Skipped  : ${skipped}`);
console.log(`❌ Failed   : ${failed}`);
console.log(`🗄️  Total DB : ${getStats().total}`);
