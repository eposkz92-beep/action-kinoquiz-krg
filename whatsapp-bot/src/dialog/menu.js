/**
 * src/dialog/menu.js
 * WhatsApp Menu and Informational Cards for ACTION Kinoquiz
 * 
 * Strict WhatsApp Markdown Compliance:
 * - Single asterisk bold (*bold*)
 * - Single underscore italic (_italic_)
 * - NO double asterisks (**)
 * - NO Markdown headings (#)
 */

/**
 * Main Navigation Menu Card
 * @returns {string}
 */
export function getMainMenuCard() {
  return [
    '🎬 *ACTION Киноквиз Караганда* 🍿',
    'Интеллектуальный баттл для киноманов в караоке-баре «То Место»!',
    '',
    'Выберите нужный пункт, отправив цифру от 1 до 5:',
    '',
    '1️⃣ *Забронировать стол* — записать команду на игру',
    '2️⃣ *Афиша игр* — расписание и темы ближайших игр',
    '3️⃣ *Адрес и 2GIS* — где играем и как добраться',
    '4️⃣ *Правила и Лиги* — формат игры, раунды и система лиг',
    '5️⃣ *Связаться с организатором* — прямой контакт (+7 701 186 31 90)',
    '',
    '_В любой момент отправьте *0* или *меню*, чтобы вернуться в главное меню._'
  ].join('\n');
}

export const getMainMenuText = getMainMenuCard;
export const renderMainMenu = getMainMenuCard;

/**
 * Schedule Card (Option 2)
 * @param {Array<Object>} games
 * @returns {string}
 */
export function getScheduleCard(games = []) {
  const lines = [
    '📅 *Афиша игр ACTION Киноквиз* 🎬',
    ''
  ];

  if (!games || games.length === 0) {
    lines.push('На ближайшее время открытых игр нет. Следите за анонсами в Instagram @action_kinoquiz_krg!');
  } else {
    games.forEach((g, idx) => {
      lines.push(`${idx + 1}. *${g.title}*`);
      const datePart = g.dateStr ? `${g.dayName ? g.dayName + ', ' : ''}${g.dateStr}` : 'Каждый вторник';
      const timePart = g.timeStr || '19:30';
      lines.push(`   🗓️ ${datePart} в ${timePart}`);
      lines.push('   📍 Караоке-бар «То Место» (пр. Нуркена Абдирова, 5)');
      lines.push(`   💰 ${g.price || '3 000 ₸'} с игрока`);
      if (g.desc) lines.push(`   📌 _${g.desc}_`);
      if (g.status) lines.push(`   🏷️ Статус: *${g.status}*`);
      lines.push('');
    });
  }

  lines.push('---');
  lines.push('Чтобы забронировать стол, отправьте *1*.');
  lines.push('_Для возврата в меню отправьте *0*._');

  return lines.join('\n');
}

export const getScheduleText = getScheduleCard;
export const renderScheduleCard = getScheduleCard;

/**
 * Venue & 2GIS Card (Option 3)
 * @returns {string}
 */
export function getVenueCard() {
  return [
    '📍 *Локация проведения ACTION Киноквиз*',
    '',
    'Мы играем в уютном караоке-баре:',
    '🏛️ *Караоке-бар «То Место»*',
    '📌 *Адрес:* г. Караганда, пр. Нуркена Абдирова, д. 5',
    '⏱️ *Время игр:* каждый вторник в 19:30',
    '',
    '🗺️ *Маршрут и схема проезда в 2GIS:*',
    'https://2gis.kz/karaganda/search/%D0%A2%D0%BE%20%D0%BC%D0%B5%D1%81%D1%82%D0%BE%20%D0%9D%D1%83%D1%80%D0%BA%D0%B5%D0%BD%D0%B0%20%D0%90%D0%B1%D0%B4%D0%B8%D1%80%D0%BE%D0%B2%D0%B0%2C%205',
    '',
    '_Еда и напитки по меню заведения заказываются отдельно._',
    '_Для возврата в меню отправьте *0*._'
  ].join('\n');
}

export const getLocationText = getVenueCard;
export const renderVenueCard = getVenueCard;

/**
 * Rules & Leagues Card (Option 4)
 * @returns {string}
 */
export function getRulesCard() {
  return [
    '📜 *Правила и формат ACTION Киноквиз* 🏆',
    '',
    '⏱️ *Длительность:* 2–2.5 часа азарта и драйва',
    '👥 *Команда:* от 2 до 10 человек (или 1 — мы подберём вам команду новичков)',
    '💰 *Взнос:* 3 000 ₸ с игрока (призовой фонд, кубки, организация)',
    '',
    '🎯 *Раунды игры (6–7 туров):*',
    '1. *Кадры & Разминка* — угадай фильм по деталям и стоп-кадрам',
    '2. *«Кого скрыли?»* — видеовопросы с закрытыми героями и предметами',
    '3. *Brainstorm* — логика и сопоставление фактов',
    '4. *Саундтреки & Аудио* — узнай картину по первым секундам OST',
    '5. *Мэтч, Цитаты & Мемы* — персонажи, цитаты и культовые киномемы',
    '6. *Endgame (Ставки)* — финальный тур со ставками на баллы!',
    '',
    '🛡️ *Система лиг:*',
    '💜 *Лига «Падаваны»* — для новичков и тех, кто играет для отдыха. Свой отдельный пьедестал и награды!',
    '💚 *Лига «Джедаи»* — опытные команды и чемпионы. Битва за кубки сезона.',
    '',
    '🏆 *Сезон:* 8 эпизодов + Финальная церемония со статуэтками *«Оскар»*! Среди команд без пропусков разыгрывается бутылка рома 🥃.',
    '',
    '_Чтобы забронировать стол, отправьте *1*._',
    '_Для возврата в меню отправьте *0*._'
  ].join('\n');
}

export const getRulesAndLeaguesText = getRulesCard;
export const renderRulesCard = getRulesCard;

/**
 * Organizer Contact Card (Option 5)
 * @returns {string}
 */
export function getContactsCard() {
  return [
    '📞 *Контакты организаторов ACTION Киноквиз*',
    '',
    'Всегда на связи по любым вопросам бронирования и сотрудничества:',
    '',
    '📱 *Телефон / WhatsApp:* +7 701 186 31 90',
    '💬 *Прямой диалог в WhatsApp:*',
    'https://wa.me/77011863190',
    '',
    '📸 *Instagram:* @action_kinoquiz_krg',
    'https://www.instagram.com/action_kinoquiz_krg/',
    '',
    '🌐 *Официальный сайт:*',
    'https://action-kinoquiz-krg.web.app',
    '',
    '_Для возврата в главное меню отправьте *0*._'
  ].join('\n');
}

export const getContactsText = getContactsCard;
export const renderContactsCard = getContactsCard;

/**
 * Booking Confirmation Card
 * @param {Object} booking
 * @returns {string}
 */
export function formatConfirmationCard(booking = {}) {
  const team = booking.team_name || booking.teamName || 'Команда';
  const players = booking.players_count || booking.playersCount || 0;
  const captain = booking.captain_name || booking.captainName || 'Капитан';
  let phone = booking.captain_phone || booking.captainPhone || '';
  if (phone && !phone.startsWith('+')) {
    phone = '+' + phone;
  }
  const game = booking.game_title || booking.gameTitle || 'ACTION Киноквиз';
  const date = booking.game_date || booking.gameDate || '';
  const league = booking.league || '';
  const notes = booking.notes || '';

  const gameDisplay = date ? `${game} (${date})` : game;

  const lines = [
    '✅ *Бронь стола успешно подтверждена!* 🎟️',
    '',
    `📅 *Выбранная игра:* ${gameDisplay}`,
    `👥 *Команда:* «${team}»`,
    `♟️ *Количество игроков:* ${players} чел.`,
    `👤 *Капитан:* ${captain}`,
    `📱 *Телефон:* ${phone}`
  ];

  if (league) {
    lines.push(`🏆 *Лига:* ${league}`);
  }
  if (notes) {
    lines.push(`💬 *Примечание:* ${notes}`);
  }

  lines.push('');
  lines.push('📍 *Место:* Караоке-бар «То Место» (пр. Нуркена Абдирова, 5)');
  lines.push('⏱️ *Время:* каждый вторник в 19:30');
  lines.push('💰 *Взнос:* 3 000 ₸ с игрока');
  lines.push('');
  lines.push('Организатор свяжется с вами при необходимости. Ждём вас на игре! 🔥');
  lines.push('_Для возврата в главное меню отправьте *0*._');

  return lines.join('\n');
}

export const getConfirmationCard = formatConfirmationCard;
export const renderConfirmationCard = formatConfirmationCard;

export default {
  getMainMenuCard,
  getMainMenuText,
  renderMainMenu,
  getScheduleCard,
  getScheduleText,
  renderScheduleCard,
  getVenueCard,
  getLocationText,
  renderVenueCard,
  getRulesCard,
  getRulesAndLeaguesText,
  renderRulesCard,
  getContactsCard,
  getContactsText,
  renderContactsCard,
  formatConfirmationCard,
  getConfirmationCard,
  renderConfirmationCard
};
