require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

async function sendPermanentEmbed() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  await client.login(process.env.DISCORD_TOKEN);
  await new Promise(r => client.once('ready', r));

  const channel = await client.channels.fetch(process.env.CHANNEL_SEARCH);

  // Hapus pesan bot lama
  const msgs = await channel.messages.fetch({ limit: 20 });
  for (const msg of msgs.values()) {
    if (msg.author.id === client.user.id) await msg.delete().catch(() => {});
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎭 Cosplay Search — PixiBB')
    .setDescription(
      '**Cari cosplay dari PixiBB**\n\n' +
      '🔍 **Search** — Cari berdasarkan judul atau ID\n' +
      '📋 **List** — Lihat semua daftar cosplay\n\n' +
      '*Klik tombol di bawah untuk mulai*'
    )
    .setFooter({ text: 'PixiBB Scraper' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('open_search')
      .setLabel('🔍 Search')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setLabel('📋 List')
      .setStyle(ButtonStyle.Link)
      .setURL(`${process.env.WEB_URL || 'http://localhost:3000'}`),
  );

  const msg = await channel.send({ embeds: [embed], components: [row] });
  console.log(`✅ Embed permanen dikirim! Message ID: ${msg.id}`);
  console.log(`   Simpan ID ini di .env sebagai EMBED_MESSAGE_ID=${msg.id}`);

  await client.destroy();
}

sendPermanentEmbed().catch(console.error);
