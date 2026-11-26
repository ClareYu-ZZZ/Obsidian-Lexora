import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDictIndex, EcdictDictionary, parseCsvRecords, parseExchange, suffixCandidates,
  BookStore, HighlightIndex, scan, newFsrsState, rate, isDue,
  encodeLicense, verifyLicenseKey, computeLicenseState, hasPro, isProReviewMode, b64urlEncode,
  monthKey, normalizeLessonUsage, lessonQuotaLimit,
  type StorageAdapter, type WordEntry,
} from '../src/index';

/** In-memory StorageAdapter for tests. */
function memStorage(): StorageAdapter & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async readText(p) { return files.get(p) ?? null; },
    async writeText(p, c) { files.set(p, c); },
    async exists(p) { return files.has(p); },
    async list(folder) {
      const prefix = folder.replace(/\/$/, '') + '/';
      const names = new Set<string>();
      for (const k of files.keys()) {
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          if (!rest.includes('/')) names.add(rest);
        }
      }
      return [...names];
    },
    async mkdir() { /* no-op */ },
  };
}

const CSV = [
  'word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio',
  'race,reɪs,"n. competition\\nv. to compete in speed","n. 种族，人种；竞赛\\nvt. 和…竞赛；使急走",n:71/v:28,3,1,zk gk cet4 ky,1103,1023,d:raced/p:raced/i:racing/3:races/s:races,,',
  'races,reɪsɪz,,,,,,,,,0:race/1:3s,,',
  '"take issue with",,,"v. 不同意；与…争论",,,,,0,0,,,',
  'endoscope,ˈendəskoʊp,,n. [医] 内窥镜,,,,gre,32001,28455,s:endoscopes,,',
].join('\n');

test('csv parser handles quotes and embedded commas/newlines', () => {
  const rows = [...parseCsvRecords('a,"b,c","d""e",f\n1,2,3,4')];
  assert.deepEqual(rows[0], ['a', 'b,c', 'd"e', 'f']);
  assert.deepEqual(rows[1], ['1', '2', '3', '4']);
});

test('exchange parsing', () => {
  const { variants, lemmaOf } = parseExchange('d:raced/p:raced/i:racing/3:races/0:race/1:3s');
  assert.deepEqual([...variants].sort(), ['raced', 'races', 'racing']);
  assert.equal(lemmaOf, 'race');
});

test('suffix candidates', () => {
  assert.ok(suffixCandidates('studies').includes('study'));
  assert.ok(suffixCandidates('running').includes('run'));
  assert.ok(suffixCandidates('raced').includes('race'));
});

test('dict build + lookup + lemma following', async () => {
  const storage = memStorage();
  const res = await buildDictIndex(CSV, storage, 'cache');
  assert.equal(res.entries, 4);
  const dict = new EcdictDictionary(storage, 'cache');
  assert.equal(await dict.isReady(), true);

  const race = await dict.lookup('race');
  assert.ok(race);
  assert.equal(race.lemma, 'race');
  assert.equal(race.phoneticUS, '/reɪs/');
  assert.ok(race.senses[0].includes('种族'));
  assert.deepEqual([...race.variants].sort(), ['raced', 'races', 'racing']);
  assert.ok(race.tags.includes('cet4'));

  // inflected surface with thin entry follows 0: pointer
  const viaPointer = await dict.lookup('races');
  assert.ok(viaPointer && viaPointer.lemma === 'race');

  // unknown inflection falls back to suffix rules
  const viaRules = await dict.lookup('endoscopes');
  assert.ok(viaRules && viaRules.lemma === 'endoscope');

  // phrase lookup
  const phrase = await dict.lookup('Take Issue With');
  assert.ok(phrase && phrase.senses[0].includes('不同意'));
});

test('book store: collect, dedupe, mastered, import', async () => {
  const storage = memStorage();
  const store = new BookStore(storage, 'books');
  await store.load();
  const [defaultBook] = store.listBooks();
  assert.ok(defaultBook, 'a default book is created');

  const entry: WordEntry = {
    lemma: 'race', phoneticUS: '/reɪs/', senses: ['n. 种族；竞赛'],
    tags: ['cet4'], variants: ['races', 'raced', 'racing'],
  };
  const first = await store.collect(defaultBook.id, entry, { sentence: 'The race track.' });
  assert.equal(first.existed, false);
  const second = await store.collect(defaultBook.id, entry);
  assert.equal(second.existed, true, 'same lemma dedupes');

  assert.ok(store.isCollected('race'));
  const stats = store.stats(defaultBook.id)!;
  assert.equal(stats.total, 1);
  assert.equal(stats.notStarted, 1);

  await store.setMastered('race', true);
  assert.equal(store.findByLemma('race')!.card.status, 'mastered');
  assert.ok(store.isMastered('race'));

  const added = await store.importMastered(['hello', 'world', 'hello', 'bad word!']);
  assert.equal(added, 2);

  // reload from disk round-trips
  const store2 = new BookStore(storage, 'books');
  await store2.load();
  assert.ok(store2.isCollected('race'));
  assert.ok(store2.isMastered('hello'));
});

test('highlight index + scan', async () => {
  const storage = memStorage();
  const store = new BookStore(storage, 'books');
  await store.load();
  const book = store.listBooks()[0];
  await store.collect(book.id, {
    lemma: 'race', phoneticUS: '', senses: [], tags: [], variants: ['races', 'racing'],
  });
  const index = new HighlightIndex();
  index.rebuild(store.listBooks(), { includeMastered: false });
  assert.ok(index.match('Races'));
  const hits = scan("It's why the race track is still known; racing fans agree.", index);
  assert.deepEqual(hits.map((h) => h.text), ['race', 'racing']);
  assert.equal(hits[0].info.lemma, 'race');

  await store.setMastered('race', true);
  index.rebuild(store.listBooks(), { includeMastered: false });
  assert.equal(index.match('race'), null, 'mastered words drop out of highlight');
});

test('fsrs: rating moves due date forward', () => {
  const s0 = newFsrsState(new Date('2026-01-01T00:00:00Z'));
  const s1 = rate(s0, 'good', new Date('2026-01-01T00:00:00Z'));
  assert.ok(new Date(s1.due).getTime() > new Date('2026-01-01T00:00:00Z').getTime());
  assert.equal(s1.reps, 1);
  const card = {
    id: 'c', lemma: 'x', variants: [], phoneticUS: '', senses: [], tags: [], contexts: [],
    addedAt: '', fsrs: s1, status: 'learning' as const,
  };
  assert.equal(isDue(card, new Date('2027-01-01T00:00:00Z')), true);
});

// ---------- P1 additions ----------

import {
  ReviewLog, buildSession, buildChoices, pickExample, dayKey,
} from '../src/index';

test('card migration: single context -> contexts[]', async () => {
  const storage = memStorage();
  const legacy = {
    id: 'book-x', name: '旧词本', createdAt: '2026-01-01',
    reviewConfig: { newPerDay: 10, reviewsPerDay: 50, autoPronounce: true, modes: ['card'] },
    cards: [{
      id: 'card-1', lemma: 'race', variants: [], phoneticUS: '', senses: ['n. 竞赛'],
      tags: [], addedAt: '2026-01-01', context: { sentence: 'The race track.' },
      fsrs: newFsrsState(), status: 'new',
    }],
  };
  storage.files.set('books/book-x.json', JSON.stringify(legacy));
  const store = new BookStore(storage, 'books');
  await store.load();
  const card = store.findByLemma('race')!.card;
  assert.equal(card.contexts.length, 1);
  assert.equal(card.contexts[0].sentence, 'The race track.');
  assert.equal(card.context, undefined);
  assert.equal(store.getBook('book-x')!.reviewConfig.showExample, true, 'config backfilled');
});

test('addContext dedupes and applyRating transitions status', async () => {
  const storage = memStorage();
  const store = new BookStore(storage, 'books');
  await store.load();
  const book = store.listBooks()[0];
  await store.collect(book.id, {
    lemma: 'race', phoneticUS: '', senses: ['n. 竞赛'], tags: [], variants: [],
  }, { sentence: 'First sentence.' });
  assert.equal(await store.addContext('race', { sentence: 'Second sentence.' }), true);
  assert.equal(await store.addContext('race', { sentence: 'Second sentence.' }), false);
  assert.equal(store.findByLemma('race')!.card.contexts.length, 2);

  const updated = await store.applyRating('race', 'good');
  assert.ok(updated);
  assert.equal(updated.status, 'learning');
  assert.equal(updated.fsrs.reps, 1);
});

test('review log + session budgets', async () => {
  const storage = memStorage();
  const store = new BookStore(storage, 'books');
  await store.load();
  const book = store.listBooks()[0];
  for (let i = 0; i < 5; i++) {
    await store.collect(book.id, {
      lemma: `word${i}`, phoneticUS: '', senses: [`释义 ${i}`], tags: [], variants: [],
    });
  }
  await store.updateReviewConfig(book.id, { newPerDay: 3 });

  const log = new ReviewLog(storage, 'books/review-log.json');
  await log.load();
  const session = buildSession(store.getBook(book.id)!, log);
  assert.equal(session.length, 3, 'new cards capped by newPerDay');
  assert.ok(session.every((s) => s.kind === 'new'));

  await log.record(book.id, 'new', 20);
  await log.record(book.id, 'new', 40);
  const session2 = buildSession(store.getBook(book.id)!, log);
  assert.equal(session2.length, 1, 'today budget shrinks by logged activity');

  const days = log.lastNDays(book.id, 7);
  assert.equal(days.length, 7);
  assert.equal(days[6].date, dayKey());
  assert.equal(days[6].new, 2);
  assert.equal(days[6].progressPct, 40);

  // round-trips through storage
  const log2 = new ReviewLog(storage, 'books/review-log.json');
  await log2.load();
  assert.equal(log2.today(book.id).new, 2);
});

test('choice options and example picking', async () => {
  const storage = memStorage();
  const store = new BookStore(storage, 'books');
  await store.load();
  const book = store.listBooks()[0];
  for (let i = 0; i < 6; i++) {
    await store.collect(book.id, {
      lemma: `word${i}`, phoneticUS: '', senses: [`释义 ${i}`], tags: [], variants: [],
    });
  }
  const cards = store.getBook(book.id)!.cards;
  const target = cards[0];
  const opts = buildChoices(target, cards, 'sense');
  assert.equal(opts.length, 4);
  assert.equal(opts.filter((o) => o.correct).length, 1);
  assert.ok(opts.find((o) => o.correct)!.text === '释义 0');
  const wordOpts = buildChoices(target, cards, 'word');
  assert.ok(wordOpts.find((o) => o.correct)!.text === 'word0');

  target.contexts = [{ sentence: 'a' }, { sentence: 'b' }];
  assert.equal(pickExample(target, false), 'a');
  assert.ok(['a', 'b'].includes(pickExample(target, true)!));
});

// ---------- P2 additions ----------

import {
  parseFeed, normalizeFeedUrl, extractVideoId,
  parseSubtitle, cuesToSegments, textToSegments,
  mineLesson, DEFAULT_MINE_OPTIONS,
  buildLessonData, lessonMarkdown, lessonFolderName, fmtTime,
  htmlToText,
} from '../src/index';

const YT_ATOM = `<?xml version="1.0"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
 <title>Speak English</title>
 <entry>
  <id>yt:video:abc12345678</id>
  <yt:videoId>abc12345678</yt:videoId>
  <title>Daily Conversation &amp; Tips</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=abc12345678"/>
  <published>2026-11-10T08:00:00+00:00</published>
  <media:group><media:description>Learn fast.</media:description></media:group>
 </entry>
</feed>`;

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
 <title>BBC Learning</title>
 <item>
  <title><![CDATA[Sleep & the brain]]></title>
  <link>https://example.com/a1</link>
  <guid>a1</guid>
  <pubDate>Mon, 10 Nov 2026 08:00:00 GMT</pubDate>
  <description><![CDATA[<p>Why do we sleep? Scientists disagree.</p><p>New research helps.</p>]]></description>
 </item>
</channel></rss>`;

test('feed parsing: youtube atom + rss', () => {
  const yt = parseFeed(YT_ATOM);
  assert.equal(yt.kind, 'youtube');
  assert.equal(yt.title, 'Speak English');
  assert.equal(yt.items[0].videoId, 'abc12345678');
  assert.equal(yt.items[0].title, 'Daily Conversation & Tips');
  assert.ok(yt.items[0].published?.startsWith('2026-11-10'));

  const rss = parseFeed(RSS);
  assert.equal(rss.kind, 'article');
  assert.equal(rss.items[0].title, 'Sleep & the brain');
  assert.ok(rss.items[0].contentHtml?.includes('Why do we sleep?'));
  assert.ok(htmlToText(rss.items[0].contentHtml!).includes('Why do we sleep?'));

  assert.equal(
    normalizeFeedUrl('https://www.youtube.com/channel/UCxxxxxxxxxxxx'),
    'https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxxxxxxxxxx',
  );
  assert.equal(extractVideoId('https://youtu.be/abc12345678'), 'abc12345678');
});

const VTT = `WEBVTT

00:00.000 --> 00:02.000
It's why the race track

00:02.000 --> 00:04.500
is still known as the brick yard.

00:09.000 --> 00:12.000
Although drivers complained, the surface stayed for decades.
`;

test('subtitle parsing + sentence alignment + paragraph gap', () => {
  const cues = parseSubtitle(VTT);
  assert.equal(cues.length, 3);
  const segs = cuesToSegments(cues);
  assert.equal(segs.length, 2);
  assert.ok(segs[0].text.startsWith("It's why the race track"));
  assert.ok(Math.abs((segs[0].start ?? 0) - 0) < 0.1);
  assert.ok(Math.abs((segs[0].end ?? 0) - 4.5) < 0.3, `end=${segs[0].end}`);
  assert.equal(segs[0].paragraph, 0);
  assert.equal(segs[1].paragraph, 1, 'gap >3s starts a new paragraph');
  assert.ok(Math.abs((segs[1].start ?? 0) - 9) < 0.3);
});

test('text segmentation', () => {
  const segs = textToSegments('Para one. Second sentence!\n\nPara two here.');
  assert.equal(segs.length, 3);
  assert.equal(segs[2].paragraph, 1);
});

test('mineLesson picks tagged words and hard sentences', async () => {
  const dictMap: Record<string, Partial<import('../src/index').WordEntry>> = {
    endoscope: { lemma: 'endoscope', senses: ['n. 内窥镜'], tags: ['gre'], freqRank: 28000, variants: ['endoscopes'] },
    surface: { lemma: 'surface', senses: ['n. 表面'], tags: ['cet4'], freqRank: 1800, variants: [] },
    complain: { lemma: 'complain', senses: ['vi. 抱怨'], tags: ['cet6'], freqRank: 3200, variants: ['complained'] },
  };
  const dict = {
    async lookup(s: string) {
      const key = s.toLowerCase().replace(/s$/, '').replace(/ed$/, '');
      const hit = dictMap[s.toLowerCase()] ?? dictMap[key];
      return hit ? ({ phoneticUS: '', definitionEn: [], variants: [], tags: [], senses: [], freqRank: 0, ...hit } as import('../src/index').WordEntry) : null;
    },
  };
  const segs = textToSegments(
    'Although drivers complained about the rough surface, the doctors stuck an endoscope down my throat, which surprised everyone because nobody expected it at the race track that day.',
  );
  const mined = await mineLesson(segs, dict, { ...DEFAULT_MINE_OPTIONS, maxWords: 10 }, () => false);
  const lemmas = mined.words.map((w) => w.entry.lemma);
  assert.ok(lemmas.includes('endoscope'), `got ${lemmas}`);
  assert.ok(lemmas.includes('complain'));
  assert.ok(!lemmas.includes('surface'), 'cet4 not in levels and rank below minRank');
  assert.equal(mined.hard.length, 1);
  assert.equal(mined.hard[0].segIdx, 0);
});

test('lesson markdown generation', async () => {
  const segs = cuesToSegments(parseSubtitle(VTT));
  const mined = { words: [{ entry: { lemma: 'decade', phoneticUS: '/ˈdekeɪd/', senses: ['n. 十年'], tags: ['cet4'], variants: [] }, segIdx: 1, count: 1, score: 5 }], hard: [{ segIdx: 1, score: 9 }] };
  const data = buildLessonData({
    title: 'Brick Yard',
    source: { kind: 'youtube', url: 'https://www.youtube.com/watch?v=abc12345678' },
    media: { kind: 'youtube', videoId: 'abc12345678' },
    segments: segs,
    mined: mined as never,
  });
  const md = lessonMarkdown(data);
  assert.ok(md.includes('lexora-lesson: ' + data.id));
  assert.ok(md.includes('```lexora-player'));
  assert.ok(md.includes('| 1 | **decade** |'));
  assert.ok(md.includes('data-seg="1"'));
  assert.ok(md.includes('## 🔑 生词（1）'));
  assert.ok(md.includes('## 🧩 长难句（1）'));
  assert.ok(md.includes('## 📜 全文（每段可点跳）'));
  assert.ok(md.includes('## ✍️ 复盘'));
  assert.ok(md.includes('- **跟读**：[ ] 1 遍'));
  assert.equal(fmtTime(69), '1:09');
  assert.ok(/^\d{4}-\d{2}-\d{2}_Brick Yard$/.test(lessonFolderName('Brick Yard')));
});

// ---------- 例句库 ----------

test('dict examples.json attaches to lookups and flows to cards', async () => {
  const storage = memStorage();
  await buildDictIndex(CSV, storage, 'cache');
  storage.files.set('cache/examples.json', JSON.stringify({
    race: [{ en: 'They raced to the finish line.', zh: '他们冲向终点线。' }],
  }));
  const dict = new EcdictDictionary(storage, 'cache');
  const entry = await dict.lookup('race');
  assert.ok(entry?.examples?.[0].en.includes('finish line'));

  const store = new BookStore(storage, 'books');
  await store.load();
  const book = store.listBooks()[0];
  const { card } = await store.collect(book.id, entry!);
  assert.equal(card.dictExamples?.length, 1);

  // 复习例句回退链：无语境例句时用词典例句
  assert.equal(pickExample(card, false), 'They raced to the finish line.');
  card.contexts = [{ sentence: 'Context sentence race.' }];
  assert.equal(pickExample(card, false), 'Context sentence race.');
});

// ---------- 打卡统计与词频抽样 ----------

test('streak and lifetime from review log', async () => {
  const storage = memStorage();
  const log = new ReviewLog(storage, 'books/review-log.json');
  await log.load();
  const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return d; };
  await log.record('b1', 'new', undefined, day(-2));
  await log.record('b1', 'review', undefined, day(-1));
  // 今天还没学：streak 从昨天起算 2 天，todayDone=false
  let s = log.streak();
  assert.equal(s.todayDone, false);
  assert.equal(s.days, 2);
  await log.record('b2', 'review', undefined, day(0));
  s = log.streak();
  assert.equal(s.todayDone, true);
  assert.equal(s.days, 3);
  const life = log.lifetime();
  assert.equal(life.activeDays, 3);
  assert.equal(life.totalNew, 1);
  assert.equal(life.totalReview, 2);
});

test('sampleByBand buckets by frequency', async () => {
  const storage = memStorage();
  await buildDictIndex(CSV, storage, 'cache');
  const dict = new EcdictDictionary(storage, 'cache');
  const sampled = await dict.sampleByBand([[1, 2000], [20000, 30000]], 3);
  // race frq=1023 → band0；endoscope frq=28455 → band1；无词频/短语被排除
  const bands = new Set(sampled.map((w) => `${w.lemma}:${w.band}`));
  assert.ok(bands.has('race:0'), [...bands].join());
  assert.ok(bands.has('endoscope:1'));
  assert.ok(!sampled.some((w) => w.lemma.includes(' ')));
});

// ---------- 多记忆算法 ----------

import { rateWith } from '../src/index';

test('sm2 and leitner schedulers', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  // SM-2: 1 → 6 → interval*EF 递增
  let s = newFsrsState(now);
  s = rateWith('sm2', s, 'good', now);
  assert.equal(s.scheduled_days, 1);
  s = rateWith('sm2', s, 'good', now);
  assert.equal(s.scheduled_days, 6);
  s = rateWith('sm2', s, 'good', now);
  assert.ok(s.scheduled_days >= 13, `got ${s.scheduled_days}`);
  const failed = rateWith('sm2', s, 'again', now);
  assert.equal(failed.scheduled_days, 1);
  assert.equal(failed.reps, 0);

  // Leitner: good 升盒，again 回盒 1
  let l = newFsrsState(now);
  l = rateWith('leitner', l, 'good', now);   // box2 → 2 天
  assert.equal(l.scheduled_days, 2);
  l = rateWith('leitner', l, 'easy', now);   // box4 → 7 天
  assert.equal(l.scheduled_days, 7);
  l = rateWith('leitner', l, 'again', now);  // box1 → 1 天
  assert.equal(l.scheduled_days, 1);

  // fsrs 路径仍可用
  const f = rateWith('fsrs', newFsrsState(now), 'good', now);
  assert.equal(f.reps, 1);
});

test('youtube ASR rolling vtt: dedup + word-level timing', () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000 align:start position:0%
You<00:00:01.200><c> can</c><00:00:01.400><c> make</c><00:00:01.700><c> a</c><00:00:01.800><c> full</c>

00:00:03.000 --> 00:00:03.010 align:start position:0%
You can make a full

00:00:03.010 --> 00:00:05.000 align:start position:0%
You can make a full
sentence<00:00:03.400><c> like</c><00:00:03.700><c> this.</c>

00:00:05.000 --> 00:00:05.010 align:start position:0%
sentence like this.
`;
  const cues = parseSubtitle(vtt);
  // 纯重复行的 cue 被整条丢弃
  assert.equal(cues.length, 2);
  const joined = cues.map((c) => c.text).join(' ');
  assert.equal(joined, 'You can make a full sentence like this.');
  // 词级时间戳被解析
  assert.equal(cues[0].words?.length, 5);
  assert.equal(cues[0].words?.[1].t, 1.2);
  const segs = cuesToSegments(cues);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, 'You can make a full sentence like this.');
  // 句子起点对齐到第一个词（1.0s），而不是被重复文本撑后
  assert.ok((segs[0].start ?? 99) <= 1.01, `start=${segs[0].start}`);
  assert.ok((segs[0].end ?? 0) >= 4.9, `end=${segs[0].end}`);
});

/* ---------------- license ---------------- */

test('license: key round-trip, tamper detection, expiry', async () => {
  const { generateKeyPairSync, sign: edSign, verify: edVerify, createPublicKey } = await import('node:crypto');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const verifyFn = (msg: Uint8Array, sig: Uint8Array, pub: Uint8Array) => {
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pub)]);
    return edVerify(null, Buffer.from(msg), createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(sig));
  };

  const payload = { v: 1 as const, plan: 'pro' as const, email: 'a@b.c', iat: 1700000000000, exp: 1900000000000 };
  const sig = new Uint8Array(edSign(null, Buffer.from(JSON.stringify(payload), 'utf8'), privateKey));
  const key = encodeLicense(payload, sig);
  assert.ok(key.startsWith('LEXORA1.'));

  const ok = await verifyLicenseKey(key, rawPub, verifyFn, 1750000000000);
  assert.equal(ok.email, 'a@b.c');

  // subscription-only: a key without exp must be rejected even if correctly signed
  const noExp = { v: 1 as const, plan: 'pro' as const, email: 'a@b.c', iat: 1700000000000 } as never;
  const sigNoExp = new Uint8Array(edSign(null, Buffer.from(JSON.stringify(noExp), 'utf8'), privateKey));
  await assert.rejects(() => verifyLicenseKey(encodeLicense(noExp, sigNoExp), rawPub, verifyFn), /订阅制/);

  // tampered payload must fail
  const parts = key.split('.');
  const bad = [parts[0], b64urlEncode(new TextEncoder().encode(JSON.stringify({ ...payload, email: 'x@y.z' }))), parts[2]].join('.');
  await assert.rejects(() => verifyLicenseKey(bad, rawPub, verifyFn), /签名无效/);

  // expired key must fail
  const payloadExp = { ...payload, exp: 1700000001000 };
  // (expired well before the 'now' passed below)
  const sigExp = new Uint8Array(edSign(null, Buffer.from(JSON.stringify(payloadExp), 'utf8'), privateKey));
  await assert.rejects(
    () => verifyLicenseKey(encodeLicense(payloadExp, sigExp), rawPub, verifyFn, 1800000000000),
    /已过期/,
  );
});

test('license: trial state machine and review-mode gating', () => {
  const day = 86400_000;
  const t0 = 1700000000000;
  assert.equal(computeLicenseState({ verified: null }).tier, 'free');
  const pro = computeLicenseState({ verified: { v: 1, plan: 'pro', email: 'a@b.c', iat: t0, exp: t0 + 365 * day } });
  assert.ok(hasPro(pro));
  const trial = computeLicenseState({ verified: null, trialStartedAt: t0, now: t0 + 1 * day });
  assert.equal(trial.tier, 'trial');
  assert.equal(trial.trialDaysLeft, 2);
  // 试用换设备 → 免费并标记设备受限
  const moved = computeLicenseState({ verified: null, trialStartedAt: t0, now: t0 + 1 * day, trialDeviceOk: false });
  assert.equal(moved.tier, 'free');
  assert.ok(moved.trialDeviceBlocked);
  const over = computeLicenseState({ verified: null, trialStartedAt: t0, now: t0 + 15 * day });
  assert.equal(over.tier, 'free');
  assert.ok(over.trialExpired);
  assert.ok(!hasPro(over));
  const withErr = computeLicenseState({ verified: null, keyError: 'bad' });
  assert.equal(withErr.keyError, 'bad');
  assert.ok(isProReviewMode('listening') && isProReviewMode('cloze-spell'));
  assert.ok(!isProReviewMode('card') && !isProReviewMode('spelling'));
});


test('license: monthly lesson quota', () => {
  const nov = new Date(2026, 10, 18);
  const dec = new Date(2026, 11, 2);
  assert.equal(monthKey(nov), '2026-11');
  const fresh = normalizeLessonUsage(undefined, nov);
  assert.deepEqual(fresh, { month: '2026-11', used: 0 });
  const kept = normalizeLessonUsage({ month: '2026-11', used: 3 }, nov);
  assert.equal(kept.used, 3);
  const rolled = normalizeLessonUsage({ month: '2026-11', used: 5 }, dec);
  assert.deepEqual(rolled, { month: '2026-12', used: 0 });
  assert.equal(lessonQuotaLimit({ tier: 'free' }), 10);
  assert.equal(lessonQuotaLimit({ tier: 'trial' }), 20);
  assert.equal(lessonQuotaLimit({ tier: 'pro' }), 20);
});
