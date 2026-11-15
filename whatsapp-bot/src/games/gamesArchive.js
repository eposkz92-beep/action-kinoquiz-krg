/**
 * src/games/gamesArchive.js
 * Historical archive and analytics for past and upcoming ACTION Kinoquiz games.
 * Tracks dates, themes, player counts, team counts, revenue, and podium winners.
 */

import { getActiveGames } from './gameLoader.js';

export const PAST_GAMES_ARCHIVE = [
  {
    id: 'past-5',
    season: 'Сезон 02',
    episode: 'Спецвыпуск',
    title: 'Вселенная Гарри Поттера (Повтор) ⚡',
    theme: 'Гарри Поттер',
    date: '05.11.2026',
    dateLabel: '05 ноября 2026',
    venue: 'Караоке-бар «То Место»',
    status: 'completed',
    statusLabel: 'Завершена',
    teamsCount: 8,
    playersCount: 46,
    revenue: 138000,
    winners: {
      first: 'ДНК',
      second: 'Heavy Mental',
      third: 'MALUBULUL'
    },
    notes: 'Аншлаг, тематические костюмы и сливочное пиво'
  },
  {
    id: 'past-4',
    season: 'Сезон 02',
    episode: 'Эпизод 04',
    title: 'Halloween Vibes 🎃',
    theme: 'Хэллоуин / Ужасы',
    date: '31.10.2026',
    dateLabel: '31 октября 2026',
    venue: 'Караоке-бар «То Место»',
    status: 'completed',
    statusLabel: 'Завершена',
    teamsCount: 9,
    playersCount: 52,
    revenue: 156000,
    winners: {
      first: 'ДНК',
      second: 'Heavy Mental',
      third: 'Неудержимые Белки'
    },
    notes: 'Костюмированная хэллоуин-игра'
  },
  {
    id: 'past-3',
    season: 'Сезон 02',
    episode: 'Спецвыпуск',
    title: 'Вселенная Гарри Поттера ⚡',
    theme: 'Гарри Поттер',
    date: '22.10.2026',
    dateLabel: '22 октября 2026',
    venue: 'Караоке-бар «То Место»',
    status: 'completed',
    statusLabel: 'Завершена',
    teamsCount: 8,
    playersCount: 48,
    revenue: 144000,
    winners: {
      first: 'ДНК',
      second: 'Prodigy моё сливочное пиво',
      third: 'Те, кого нельзя было звать'
    },
    notes: 'Первый запуск поттерианы'
  },
  {
    id: 'past-2',
    season: 'Сезон 02',
    episode: 'Эпизод 03',
    title: 'Сезон 02 Эпизод 03 (Action!) 🎬',
    theme: 'Классика Кино',
    date: '16.10.2026',
    dateLabel: '16 октября 2026',
    venue: 'Караоке-бар «То Место»',
    status: 'completed',
    statusLabel: 'Завершена',
    teamsCount: 9,
    playersCount: 54,
    revenue: 162000,
    winners: {
      first: 'Heavy Mental',
      second: 'Неудержимые Белки',
      third: 'ДНК'
    },
    notes: 'Рекорд сезона по игрокам (54 чел)'
  },
  {
    id: 'past-1',
    season: 'Сезон 02',
    episode: 'Спецвыпуск',
    title: 'Сага «Сумерки» 🐺',
    theme: 'Сумерки / Мелодрамы',
    date: '09.10.2026',
    dateLabel: '09 октября 2026',
    venue: 'Караоке-бар «То Место»',
    status: 'completed',
    statusLabel: 'Завершена',
    teamsCount: 8,
    playersCount: 48,
    revenue: 144000,
    winners: {
      first: 'ДНК',
      second: 'Heavy Mental',
      third: 'Неудержимые Белки'
    },
    notes: 'Открытие осенней серии спецвыпусков'
  }
];

/**
 * Returns full historical archive merging past completed games and active live games.
 * @param {Object} [db] - Database instance
 * @param {Object} [config] - App config
 * @returns {Object} { games: Array, stats: Object }
 */
export function getGamesArchive(db = null, config = {}) {
  const pricePerPlayer = Number(config.quiz?.pricePerPlayer) || 3000;
  const activeGames = getActiveGames();
  const bookings = db && db.bookings ? (db.bookings.list({ limit: 1000 }) || []) : [];

  const liveUpcoming = activeGames.map((g, idx) => {
    const matchingBookings = bookings.filter(b => {
      const bTitle = (b.game_title || '').toLowerCase();
      const gTitle = (g.title || '').toLowerCase();
      return bTitle.includes(gTitle) || gTitle.includes(bTitle) || (g.dateStr && bTitle.includes(g.dateStr.toLowerCase()));
    });
    const playersCount = matchingBookings.reduce((sum, b) => sum + (Number(b.players_count) || 0), 0);
    const revenue = playersCount * pricePerPlayer;

    return {
      id: `active-${idx + 1}`,
      season: 'Сезон 02',
      episode: `Эпизод 0${idx + 5}`,
      title: g.title,
      theme: g.title.includes('Аниме') ? 'Аниме' : 'Киномарафон',
      date: g.dateStr || '17.11.2026',
      dateLabel: `${g.dateStr || ''} в ${g.timeStr || '19:30'}`,
      venue: config.quiz?.location || 'Караоке-бар «То Место»',
      status: 'active',
      statusLabel: 'Открыта запись',
      teamsCount: matchingBookings.length,
      playersCount,
      revenue,
      winners: null,
      notes: `Забронировано: ${matchingBookings.length} команд, ${playersCount} игроков`
    };
  });

  // All games: active first or chronological
  const allGames = [...liveUpcoming, ...PAST_GAMES_ARCHIVE];

  const totalCompletedGames = PAST_GAMES_ARCHIVE.length;
  const totalAllGames = allGames.length;
  const totalPastPlayers = PAST_GAMES_ARCHIVE.reduce((s, g) => s + g.playersCount, 0);
  const totalLivePlayers = liveUpcoming.reduce((s, g) => s + g.playersCount, 0);
  const totalPlayersAll = totalPastPlayers + totalLivePlayers;

  const totalPastRevenue = PAST_GAMES_ARCHIVE.reduce((s, g) => s + g.revenue, 0);
  const totalLiveRevenue = liveUpcoming.reduce((s, g) => s + g.revenue, 0);
  const totalRevenueAll = totalPastRevenue + totalLiveRevenue;

  const avgPlayersPerGame = totalCompletedGames > 0 ? Math.round(totalPastPlayers / totalCompletedGames) : 0;
  const avgRevenuePerGame = totalCompletedGames > 0 ? Math.round(totalPastRevenue / totalCompletedGames) : 0;

  return {
    games: allGames,
    pastGames: PAST_GAMES_ARCHIVE,
    activeGames: liveUpcoming,
    stats: {
      totalGames: totalAllGames,
      completedGames: totalCompletedGames,
      upcomingGames: liveUpcoming.length,
      totalPlayers: totalPlayersAll,
      totalRevenue: totalRevenueAll,
      avgPlayersPerGame,
      avgRevenuePerGame
    }
  };
}
