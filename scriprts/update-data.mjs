// scripts/update-data.mjs
//
// Скачивает главную страницу lm-inc-levels-knyazhna.amvera.io, вытаскивает из неё
// встроенный React/Next.js JSON с массивом employees и пересобирает data.json,
// который затем отдаётся статической страницей index.html.
//
// Запускается вручную (`node scripts/update-data.mjs`) или через
// .github/workflows/update-data.yml по расписанию.

import { writeFile, readFile } from "node:fs/promises";

const SOURCE_URL = "https://lm-inc-levels-knyazhna.amvera.io";
const OUTPUT_PATH = new URL("../data.json", import.meta.url);

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

  await writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  console.log("data.json обновлён.");
}

main().catch((err) => {
  console.error("Ошибка обновления данных:", err.message);
  process.exit(1);
});
