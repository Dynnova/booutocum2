const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ComponentType,
  ChannelType,
} = require('discord.js');
const { searchCosplay, getStats, getById, getDb } = require('./database');
const { getCachedThread, saveThreadCache, makeQueryKey, deleteExpiredThreads } = require('./threadCache');

const TIMEOUT = 180_000;
const THREAD_CHANNEL_ID = process.env.THREAD_SEARCH;

// ─── Global queue ─────────────────────────────────────────────────────────────
const sendQueue = [];
let isSending = false;

async function processQueue() {
  if (isSending || !sendQueue.length) return;
  isSending = true;

  while (sendQueue.length) {
    const { thread, item, requester } = sendQueue[0];

    for (let i = 1; i < sendQueue.length; i++) {
      const q = sendQueue[i];
      try {
        await q.interaction.editReply({
          embeds: [new EmbedBuilder()
            .setColor(0xFAA61A)
            .setTitle('⏳ Dalam antrean...')
            .setDescription(
              `➡️ <#${q.thread.id}>\n\n` +
              `Posisi kamu: **#${i}** dari ${sendQueue.length - 1} antrean\n` +
              `Sedang mengirim untuk <@${requester.id}>`
            )
            .setThumbnail(q.item.cover_url)
            .setFooter({ text: 'Akan otomatis diproses saat giliran tiba' }),
          ],
        }).catch(() => {});
      } catch {}
    }

    await sendImagesToThread(thread, item, requester);
    await sendQueue[0].onDone();
    sendQueue.shift();
  }

  isSending = false;
}

// ─── Embeds & Buttons ─────────────────────────────────────────────────────────

function buildPreviewEmbed(item, idx, total, cache) {
  const lines = [
    `\`ID: ${item.id}\`${cache ? ` · 🔗 \`${cache.short_id}\`` : ''}`,
  ].join('\n');

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`🎭 ${item.title || 'Unknown'}`)
    .setDescription(lines)
    .setImage(item.cover_url)
    .setURL(item.page_url)
    .setFooter({ text: `Hasil ${idx + 1} dari ${total}` });
}

function buildNavButtons(idx, total, cosplayId, hasCache) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('prev')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(idx === 0),
    new ButtonBuilder()
      .setCustomId('pageinfo')
      .setLabel(`${idx + 1} / ${total}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('next')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(idx >= total - 1),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`view_${cosplayId}`)
      .setLabel(hasCache ? '🔗 Lihat Thread' : '👁️ Lihat')
      .setStyle(hasCache ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('close')
      .setLabel('✖')
      .setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2];
}

// ─── Fallback: scrape images langsung dari mitaku post ───────────────────────

async function scrapeImagesFromPost(pageUrl) {
  const axios = require('axios');
  const cheerio = require('cheerio');
  const imgUrls = [];

  try {
    const res = await axios.get(pageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000,
    });
    const $ = cheerio.load(res.data);
    const seen = new Set();

    // 1. data-mfp-src
    $('[data-mfp-src]').each((_, el) => {
      const src = $(el).attr('data-mfp-src');
      if (src && !seen.has(src)) { seen.add(src); imgUrls.push(src); }
    });

    // 2. a[href] → gambar asli, bukan thumbnail
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (
        /\.(jpg|jpeg|png|webp)/i.test(href) &&
        !/-\d+x\d+\.(jpg|jpeg|png|webp)/i.test(href) &&
        !seen.has(href)
      ) {
        seen.add(href);
        imgUrls.push(href);
      }
    });

    // 3. gallery selectors
    $('.gallery-item a, .mfp-gallery a, [class*="gallery"] a').each((_, el) => {
      const href = $(el).attr('href');
      if (href && !seen.has(href)) { seen.add(href); imgUrls.push(href); }
    });
  } catch {}

  return imgUrls;
}

// ─── Send images to thread ────────────────────────────────────────────────────

async function sendImagesToThread(thread, item, requester) {
  const headerEmbed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`🎭 ${item.title || 'Unknown'}`)
    .setDescription([
      `**Link:** [Buka di mitaku](${item.page_url})`,
      `\`ID: ${item.id}\``,
    ].join('\n'))
    .setImage(item.cover_url)
    .setThumbnail(item.cover_url)
    .setFooter({ text: `Diminta oleh ${requester.tag}` })
    .setTimestamp();

  await thread.send({ embeds: [headerEmbed] });

  let imgUrls = [];
  if (item.image_urls) {
    try { imgUrls = JSON.parse(item.image_urls); } catch {}
  }

  // Fallback: scrape langsung kalau image_urls kosong
  if (!imgUrls.length) {
    imgUrls = await scrapeImagesFromPost(item.page_url);
  }

  if (!imgUrls.length) {
    await thread.send('⚠️ Tidak ada gambar ditemukan.');
    return;
  }

  const BATCH = 5;
  for (let i = 0; i < imgUrls.length; i += BATCH) {
    const batch = imgUrls.slice(i, i + BATCH);
    await thread.send({
      embeds: batch.map((url, j) =>
        new EmbedBuilder()
          .setImage(url)
          .setFooter({ text: `${i + j + 1} / ${imgUrls.length}` })
      ),
    });
    await new Promise(r => setTimeout(r, 800));
  }

  await thread.send(`✅ **${imgUrls.length}** gambar dikirim.`);
}

// ─── Handle search modal submit ───────────────────────────────────────────────

async function handleSearchSubmit(interaction) {
  const query = interaction.fields.getTextInputValue('search_input').trim();
  await interaction.deferReply({ ephemeral: true });

  deleteExpiredThreads();

  const isIdSearch = /^\d+$/.test(query);
  let results, total;

  if (isIdSearch) {
    const row = getById(query);
    results = row ? [row] : [];
    total = results.length;
  } else {
    ({ results, total } = searchCosplay(query, 20, 0));
  }

  if (!results.length) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xFF4444)
          .setTitle('❌ Tidak ditemukan')
          .setDescription(
            isIdSearch
              ? `Tidak ada cosplay dengan ID **${query}**`
              : `Tidak ada hasil untuk **"${query}"**`
          )
          .setFooter({ text: `DB: ${getStats().total} cosplay` }),
      ],
    });
  }

  let idx = 0;
  const getItem = () => results[idx];
  const getCache = () => getCachedThread(makeQueryKey(getItem().id));

  const msg = await interaction.editReply({
    embeds: [buildPreviewEmbed(getItem(), idx, total, getCache())],
    components: buildNavButtons(idx, total, getItem().id, !!getCache()),
  });

  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: TIMEOUT,
    filter: i => i.user.id === interaction.user.id,
  });

  collector.on('collect', async btn => {
    if (btn.customId === 'close') {
      collector.stop();
      await btn.update({ components: [] });
      return;
    }

    if (btn.customId === 'prev') idx = Math.max(0, idx - 1);
    else if (btn.customId === 'next') idx = Math.min(total - 1, idx + 1);
    else if (btn.customId.startsWith('view_')) {
      const cosplayId = parseInt(btn.customId.split('_')[1]);
      const item = getItem();
      const key = makeQueryKey(cosplayId);
      const existing = getCachedThread(key);

      if (existing) {
        try {
          const threadChannel = await btn.client.channels.fetch(THREAD_CHANNEL_ID);
          const existingThread = await threadChannel.threads.fetch(existing.thread_id).catch(() => null);
          if (existingThread) {
            await existingThread.send(
              `> 👀 <@${interaction.user.id}> sedang melihat thread yang dibuat oleh <@${existing.creator_id}>\n` +
              `> \`ID Cosplay: ${item.id}\` · \`Thread: ${existing.short_id}\``
            );
          }
        } catch {}

        await btn.update({
          embeds: [
            new EmbedBuilder()
              .setColor(0x57F287)
              .setTitle('🔗 Thread sudah ada!')
              .setDescription(
                `Thread **${item.title}** sudah dibuat oleh <@${existing.creator_id}>\n\n` +
                `➡️ <#${existing.thread_id}>\n` +
                `\`ID Cosplay: ${item.id}\` · \`Thread: ${existing.short_id}\``
              )
              .setThumbnail(item.cover_url)
              .setFooter({ text: 'TTL thread direset ke 14 hari' }),
          ],
          components: [],
        });
        collector.stop();
        return;
      }

      await btn.deferUpdate();

      try {
        const threadChannel = await btn.client.channels.fetch(THREAD_CHANNEL_ID);
        const threadName = (item.title || 'Unknown').slice(0, 100);

        const isForumChannel = threadChannel.type === ChannelType.GuildForum;
        const thread = isForumChannel
          ? await threadChannel.threads.create({
              name: threadName,
              autoArchiveDuration: 10080,
              message: {
                embeds: [
                  new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle(`🎭 ${item.title || 'Unknown'}`)
                    .setDescription(
                      `Diminta oleh <@${interaction.user.id}>\n` +
                      `**Link:** [Buka di mitaku](${item.page_url})\n` +
                      `\`ID: ${item.id}\``
                    )
                    .setImage(item.cover_url)
                    .setThumbnail(item.cover_url)
                    .setTimestamp(),
                ],
              },
            })
          : await threadChannel.threads.create({
              name: threadName,
              autoArchiveDuration: 10080,
              type: ChannelType.PublicThread,
              reason: `Diminta oleh ${interaction.user.tag}`,
            });

        const shortId = saveThreadCache({
          queryKey: key,
          threadId: thread.id,
          threadName,
          creatorId: interaction.user.id,
          creatorTag: interaction.user.tag,
          cosplayId,
        });

        const queuePos = sendQueue.length;

        sendQueue.push({
          thread,
          item,
          requester: interaction.user,
          interaction,
          shortId,
          onDone: async () => {
            try {
              await interaction.editReply({
                embeds: [
                  new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('✅ Selesai dikirim!')
                    .setDescription(
                      `➡️ <#${thread.id}>\n` +
                      `\`ID Cosplay: ${item.id}\` · \`Thread: ${shortId}\``
                    )
                    .setThumbnail(item.cover_url),
                ],
              });
            } catch {}
          },
        });

        if (queuePos === 0) {
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle('✅ Thread dibuat!')
                .setDescription(
                  `➡️ <#${thread.id}>\n` +
                  `Dibuat oleh <@${interaction.user.id}>\n\n` +
                  `\`ID Cosplay: ${item.id}\` · \`Thread: ${shortId}\`\n\n` +
                  `⏳ Sedang mengirim gambar...`
                )
                .setThumbnail(item.cover_url)
                .setFooter({ text: 'Thread dihapus setelah 14 hari tidak ada yang melihat' }),
            ],
            components: [],
          });
        } else {
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setColor(0xFAA61A)
                .setTitle('⏳ Masuk antrean!')
                .setDescription(
                  `➡️ <#${thread.id}>\n\n` +
                  `Posisi kamu: **#${queuePos}** dari ${queuePos} antrean\n` +
                  `\`ID Cosplay: ${item.id}\` · \`Thread: ${shortId}\``
                )
                .setThumbnail(item.cover_url)
                .setFooter({ text: 'Gambar akan otomatis dikirim saat giliran tiba' }),
            ],
            components: [],
          });
        }

        processQueue();
        collector.stop();
      } catch (err) {
        await interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0xFF4444).setTitle('❌ Gagal').setDescription(err.message)],
          components: [],
        });
      }
      return;
    }

    const item = getItem();
    await btn.update({
      embeds: [buildPreviewEmbed(item, idx, total, getCache())],
      components: buildNavButtons(idx, total, item.id, !!getCache()),
    });
  });

  collector.on('end', async (_, reason) => {
    if (reason === 'time') {
      try { await interaction.editReply({ components: [] }); } catch {}
    }
  });
}

// ─── Handle permanent button ──────────────────────────────────────────────────

async function handlePermanentButton(interaction) {
  if (interaction.customId !== 'open_search') return;

  const modal = new ModalBuilder()
    .setCustomId('search_modal')
    .setTitle('🔍 Cari Cosplay');

  const input = new TextInputBuilder()
    .setCustomId('search_input')
    .setLabel('Judul cosplay atau ID')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('contoh: Hoshilily, Hidori Rose, 123...')
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(100);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

module.exports = { handlePermanentButton, handleSearchSubmit };
