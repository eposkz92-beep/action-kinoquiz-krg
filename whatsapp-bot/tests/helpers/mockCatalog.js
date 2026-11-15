/**
 * tests/helpers/mockCatalog.js
 * Dynamic Instagram State Fixture Generator for ACTION Kinoquiz Bot Testing
 */
import fs from 'node:fs';
import path from 'node:path';

const RU_MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
];

const RU_DAYS = [
  'Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'
];

function formatDateStr(date) {
  const d = new Date(date);
  return `${d.getDate()} ${RU_MONTHS[d.getMonth()]}`;
}

function formatDayName(date) {
  const d = new Date(date);
  return RU_DAYS[d.getDay()];
}

/**
 * Creates a dynamic mock catalog fixture for various test scenarios.
 * @param {Object} [options]
 * @param {string} [options.preset='default'] - 'default' | 'empty' | 'past_only' | 'today_tuesday' | 'single_future'
 * @param {Date|string|number} [options.now] - Base reference date
 * @param {Array<Object>} [options.customGames] - Custom game definitions
 * @returns {Object} Catalog generator result: { data, writeTo(filePath) }
 */
export function createMockCatalog(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const ONE_DAY_MS = 86400000;

  let posts = {};
  let activeGames = [];

  if (options.preset === 'empty') {
    posts = {};
    activeGames = [];
  } else if (options.preset === 'past_only') {
    posts['POST_PAST_1'] = {
      type: 'ANNOUNCEMENT',
      date_utc: new Date(now.getTime() - 7 * ONE_DAY_MS).toISOString().split('.')[0],
      title: 'Прошедшая игра: Вселенная Гарри Поттера',
      image_path: 'assets/images/poster-past-hp.jpg'
    };
    posts['POST_PAST_2'] = {
      type: 'ANNOUNCEMENT',
      date_utc: new Date(now.getTime() - 14 * ONE_DAY_MS).toISOString().split('.')[0],
      title: 'Прошедшая игра: Сага Сумерки',
      image_path: 'assets/images/poster-past-twilight.jpg'
    };
    posts['POST_RESULTS'] = {
      type: 'RESULTS',
      date_utc: new Date(now.getTime() - 5 * ONE_DAY_MS).toISOString().split('.')[0],
      title: 'Итоги квиза 🎬',
      image_path: 'assets/images/results.jpg'
    };
    activeGames = [];
  } else if (options.preset === 'today_tuesday') {
    // Scheduled for today at 19:30 Karaganda time
    const todayStr = now.toISOString().split('T')[0];
    const nextWeekDate = new Date(now.getTime() + 7 * ONE_DAY_MS);
    posts['POST_TODAY'] = {
      type: 'ANNOUNCEMENT',
      date_utc: `${todayStr}T19:30:00`,
      title: 'Сегодняшний Киноквиз: 100 вопросов',
      image_path: 'assets/images/poster-today-100.jpg'
    };
    // Include another future game next week
    posts['POST_NEXT_WEEK'] = {
      type: 'ANNOUNCEMENT',
      date_utc: nextWeekDate.toISOString().split('.')[0],
      title: 'Культовые Аниме',
      image_path: 'assets/images/poster-anime.jpg'
    };
    activeGames = [
      {
        id: 'game-today',
        title: 'Сегодняшний Киноквиз: 100 вопросов',
        dateStr: formatDateStr(now),
        timeStr: '19:30',
        dayName: formatDayName(now),
        price: '3 000 ₸',
        status: 'open',
        desc: 'Караоке-бар «То Место»'
      },
      {
        id: 'game-next-week',
        title: 'Культовые Аниме',
        dateStr: formatDateStr(nextWeekDate),
        timeStr: '19:30',
        dayName: formatDayName(nextWeekDate),
        price: '3 000 ₸',
        status: 'open',
        desc: 'Караоке-бар «То Место»'
      }
    ];
  } else if (options.preset === 'single_future') {
    const futureDate = new Date(now.getTime() + 3 * ONE_DAY_MS);
    posts['POST_FUTURE_1'] = {
      type: 'ANNOUNCEMENT',
      date_utc: futureDate.toISOString().split('.')[0],
      title: 'Киномарафон: 100 вопросов',
      image_path: 'assets/images/poster-100.jpg'
    };
    activeGames = [
      {
        id: 'game-1',
        title: 'Киномарафон: 100 вопросов',
        dateStr: formatDateStr(futureDate),
        timeStr: '19:30',
        dayName: formatDayName(futureDate),
        price: '3 000 ₸',
        status: 'open',
        desc: 'Караоке-бар «То Место»'
      }
    ];
  } else {
    // Default preset: 2 upcoming future games, 1 past game, 1 results, 1 standings
    const futureDate1 = new Date(now.getTime() + 3 * ONE_DAY_MS);
    const futureDate2 = new Date(now.getTime() + 10 * ONE_DAY_MS);
    posts['POST_FUTURE_1'] = {
      type: 'ANNOUNCEMENT',
      date_utc: futureDate1.toISOString().split('.')[0],
      title: 'Киномарафон: 100 вопросов',
      image_path: 'assets/images/poster-100.jpg'
    };
    posts['POST_FUTURE_2'] = {
      type: 'ANNOUNCEMENT',
      date_utc: futureDate2.toISOString().split('.')[0],
      title: 'Культовые Аниме',
      image_path: 'assets/images/poster-anime.jpg'
    };
    posts['POST_PAST_3'] = {
      type: 'ANNOUNCEMENT',
      date_utc: new Date(now.getTime() - 14 * ONE_DAY_MS).toISOString().split('.')[0],
      title: 'Вселенная Гарри Поттера',
      image_path: 'assets/images/poster-hp.jpg'
    };
    posts['POST_RESULTS_4'] = {
      type: 'RESULTS',
      date_utc: new Date(now.getTime() - 5 * ONE_DAY_MS).toISOString().split('.')[0],
      title: 'Итоги квиза: Halloween 🎃',
      image_path: 'assets/images/results-halloween.jpg'
    };
    posts['POST_STANDINGS_5'] = {
      type: 'STANDINGS',
      date_utc: new Date(now.getTime() - 6 * ONE_DAY_MS).toISOString().split('.')[0],
      teams_count: 9
    };
    activeGames = [
      {
        id: 'game-1',
        title: 'Киномарафон: 100 вопросов',
        dateStr: formatDateStr(futureDate1),
        timeStr: '19:30',
        dayName: formatDayName(futureDate1),
        price: '3 000 ₸',
        status: 'open',
        desc: 'Караоке-бар «То Место»'
      },
      {
        id: 'game-2',
        title: 'Культовые Аниме',
        dateStr: formatDateStr(futureDate2),
        timeStr: '19:30',
        dayName: formatDayName(futureDate2),
        price: '3 000 ₸',
        status: 'open',
        desc: 'Караоке-бар «То Место»'
      }
    ];
  }

  // Override with customGames if explicitly provided
  if (Array.isArray(options.customGames)) {
    posts = {};
    activeGames = [];
    options.customGames.forEach((g, idx) => {
      const postId = `POST_CUSTOM_${idx + 1}`;
      const type = g.type || 'ANNOUNCEMENT';
      const postDateStr = g.dateUtc || new Date(now.getTime() + (idx + 1) * ONE_DAY_MS).toISOString().split('.')[0];
      posts[postId] = {
        type,
        date_utc: postDateStr,
        title: g.title || `Игра ${idx + 1}`,
        image_path: g.imagePath || `assets/images/poster-custom-${idx + 1}.jpg`
      };
      if (g.teams_count !== undefined) {
        posts[postId].teams_count = g.teams_count;
      }
      if (type === 'ANNOUNCEMENT') {
        const gameDate = new Date(postDateStr);
        activeGames.push({
          id: g.id || `game-${idx + 1}`,
          title: g.title || `Игра ${idx + 1}`,
          dateStr: g.dateStr || formatDateStr(gameDate),
          timeStr: g.timeStr || '19:30',
          dayName: g.dayName || formatDayName(gameDate),
          price: g.price || '3 000 ₸',
          status: g.status || 'open',
          desc: g.desc || 'Караоке-бар «То Место»'
        });
      }
    });
  }

  const catalogData = {
    version: 1,
    profile: 'action_kinoquiz_krg',
    last_sync_utc: now.toISOString(),
    processed_posts: posts,
    active_games: activeGames
  };

  return {
    data: catalogData,
    /**
     * Writes catalog JSON to specified path.
     * @param {string} targetPath
     * @returns {string} Absolute target path
     */
    writeTo(targetPath) {
      const resolved = path.resolve(targetPath);
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(resolved, JSON.stringify(catalogData, null, 2), 'utf-8');
      return resolved;
    }
  };
}

export default createMockCatalog;
