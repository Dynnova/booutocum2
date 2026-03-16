require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { handlePermanentButton, handleSearchSubmit } = require('./searchHandler');
const { deleteExpiredThreads } = require('./threadCache');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isButton()) {
      await handlePermanentButton(interaction);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId === 'search_modal') {
      await handleSearchSubmit(interaction);
      return;
    }
  } catch (err) {
    console.error('❌ Interaction error:', err);
  }
});

client.once(Events.ClientReady, async c => {
  console.log(`\n🤖 Bot ready! ${c.user.tag}`);
  console.log(`🔍 Search channel : ${process.env.CHANNEL_SEARCH}`);
  console.log(`🧵 Thread channel : ${process.env.THREAD_SEARCH}`);
  console.log(`🌐 Web list URL   : ${process.env.WEB_URL || 'http://localhost:3000'}`);

  const expired = deleteExpiredThreads();
  if (expired.length) {
    console.log(`🗑️  Deleted ${expired.length} expired thread cache(s)`);
    for (const row of expired) {
      try {
        const threadChannel = await c.channels.fetch(process.env.THREAD_SEARCH).catch(() => null);
        if (!threadChannel) continue;
        const thread = await threadChannel.threads.fetch(row.thread_id).catch(() => null);
        if (thread) {
          await thread.delete('Thread expired (14 hari tidak ada viewer)').catch(() => {});
          console.log(`  🗑️  Deleted thread: ${row.thread_name}`);
        }
      } catch {}
    }
  }

  setInterval(async () => {
    const expired = deleteExpiredThreads();
    if (!expired.length) return;
    console.log(`🗑️  Hourly cleanup: ${expired.length} expired thread(s)`);
    for (const row of expired) {
      try {
        const threadChannel = await c.channels.fetch(process.env.THREAD_SEARCH).catch(() => null);
        if (!threadChannel) continue;
        const thread = await threadChannel.threads.fetch(row.thread_id).catch(() => null);
        if (thread) {
          await thread.delete('Thread expired (14 hari tidak ada viewer)').catch(() => {});
        }
      } catch {}
    }
  }, 60 * 60 * 1000);
});

client.login(process.env.DISCORD_TOKEN);
