// scripts/update-data.mjs
//
// Скачивает главную страницу lm-inc-levels-knyazhna.amvera.io, вытаскивает из неё
// встроенный React/Next.js JSON с массивом employees и пересобирает data.json,
// который затем отдаётся статической страницей index.html.
//
// Дополнительно, при обнаружении изменений баллов:
//  - отправляет сообщение в Telegram (если заданы TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID);
//  - сохраняет предыдущую версию таблицы в history/, чтобы её можно было
//    посмотреть на сайте («Посмотреть старые таблицы»).
//
// Запускается вручную (`node scripts/update-data.mjs`) или через
// .github/workflows/update-data.yml по расписанию.

import { writeFile, readFile, mkdir } from "node:fs/promises";

const SOURCE_URL = "https://lm-inc-levels-knyazhna.amvera.io";
const OUTPUT_PATH = new URL("../data.json", import.meta.url);
const HISTORY_DIR = new URL("../history/", import.meta.url);
const HISTORY_INDEX_PATH = new URL("../history/index.json", import.meta.url);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

function extractBalancedArray(text, startIndex) {
  // startIndex должен указывать на символ '[' начала массива
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") depth++;
    if (ch === "]") {
      depth--;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }
  throw new Error("Не удалось найти конец массива employees (скобки не сбалансированы)");
}

function parseEmployeesFromHtml(html) {
  // HTML отдаёт данные внутри Next.js flight-скрипта в виде экранированной JSON-строки,
  // например: ...\"employees\":[{\"id\":\"...\"}]...
  // Сначала снимаем экранирование кавычек, чтобы получить обычный JSON-текст.
  const unescaped = html.replace(/\\"/g, '"');

  const marker = '"employees":';
  const markerIndex = unescaped.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error('Не нашёл поле "employees" в HTML-странице источника — возможно, вёрстка сайта изменилась');
  }

  const arrayStart = unescaped.indexOf("[", markerIndex);
  if (arrayStart === -1) {
    throw new Error('Не нашёл начало массива employees ("[")');
  }

  const arrayText = extractBalancedArray(unescaped, arrayStart);
  const employees = JSON.parse(arrayText);

  if (!Array.isArray(employees) || employees.length === 0) {
    throw new Error("Массив employees пуст или имеет неверный формат");
  }

  // Оставляем только нужные поля, приводим к стабильному виду
  return employees.map((e) => ({
    id: e.id,
    serial: e.serial,
    level: e.level,
    rating: e.rating,
  }));
}

function diffEmployees(oldList, newList) {
  const oldMap = new Map(oldList.map((e) => [e.serial, e]));
  const changes = [];
  for (const emp of newList) {
    const old = oldMap.get(emp.serial);
    if (!old) {
      changes.push({ serial: emp.serial, oldRating: null, newRating: emp.rating, delta: null });
    } else if (old.rating !== emp.rating) {
      const delta = Math.round((emp.rating - old.rating) * 10) / 10;
      changes.push({ serial: emp.serial, oldRating: old.rating, newRating: emp.rating, delta });
    }
  }
  return changes;
}

function formatChangeLine(c) {
  if (c.oldRating === null) {
    return `№${c.serial}: новый участник, баллы ${c.newRating}`;
  }
  const sign = c.delta > 0 ? "+" : "";
  return `№${c.serial}: ${c.oldRating} → ${c.newRating} (${sign}${c.delta})`;
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы — уведомление в Telegram пропущено.");
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`Не удалось отправить сообщение в Telegram (HTTP ${res.status}): ${body}`);
  } else {
    console.log("Уведомление в Telegram отправлено.");
  }
}

async function notifyChanges(changes) {
  if (changes.length === 0) return;

  const header = `Изменения баллов LM.inc (${changes.length}):\n`;
  const lines = changes.map(formatChangeLine);

  // Telegram режет сообщения длиннее ~4096 символов — бьём на части при необходимости
  const chunks = [];
  let current = header;
  for (const line of lines) {
    if ((current + line + "\n").length > 3500) {
      chunks.push(current);
      current = "";
    }
    current += line + "\n";
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await sendTelegramMessage(chunk);
  }
}

async function saveHistorySnapshot(previousPayload) {
  await mkdir(HISTORY_DIR, { recursive: true });

  const safeStamp = previousPayload.updatedAt.replace(/[:.]/g, "-");
  const fileName = `${safeStamp}.json`;
  const filePath = new URL(fileName, HISTORY_DIR);

  await writeFile(filePath, JSON.stringify(previousPayload, null, 2) + "\n", "utf-8");

  let index = { snapshots: [] };
  try {
    index = JSON.parse(await readFile(HISTORY_INDEX_PATH, "utf-8"));
  } catch {
    // индекса ещё нет — создадим новый
  }

  index.snapshots.push({ file: fileName, updatedAt: previousPayload.updatedAt });
  // Самые новые снимки — в начале списка, чтобы на сайте выпадающий список показывал их первыми
  index.snapshots.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  await writeFile(HISTORY_INDEX_PATH, JSON.stringify(index, null, 2) + "\n", "utf-8");
  console.log(`Сохранён снимок истории: history/${fileName}`);
}

async function main() {
  console.log(`Скачиваю ${SOURCE_URL} ...`);
  const res = await fetch(SOURCE_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; LM-inc-levels-mirror/1.0)",
    },
  });

  if (!res.ok) {
    throw new Error(`Источник вернул HTTP ${res.status}`);
  }

  const html = await res.text();
  const employees = parseEmployeesFromHtml(html);

  console.log(`Найдено сотрудников: ${employees.length}`);

  const payload = {
    updatedAt: new Date().toISOString(),
    sourceUrl: SOURCE_URL,
    employees,
  };

  // Не перезаписываем файл, если данные не изменились (кроме штампа времени) —
  // это уменьшает число пустых коммитов в истории репозитория.
  let previous = null;
  try {
    previous = JSON.parse(await readFile(OUTPUT_PATH, "utf-8"));
  } catch {
    // файла ещё нет — это нормально при первом запуске
  }

  const changed =
    !previous ||
    JSON.stringify(previous.employees) !== JSON.stringify(payload.employees);

  if (!changed) {
    console.log("Данные не изменились с прошлого запуска — data.json не трогаю (кроме штампа можно оставить старый).");
    return;
  }

  if (previous) {
    const changes = diffEmployees(previous.employees, payload.employees);
    await saveHistorySnapshot(previous);
    await notifyChanges(changes);
  }

  await writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  console.log("data.json обновлён.");
}

main().catch((err) => {
  console.error("Ошибка обновления данных:", err.message);
  process.exit(1);
});
