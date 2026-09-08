// DOM overlay: countdown, lap, position, speed, timer, results.

const ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

function fmt(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export function createHud(root) {
  const el = (id) => root.querySelector(`#${id}`);
  const els = {
    lap: el('lap'), time: el('time'), pos: el('pos'), speed: el('speed'),
    countdown: el('countdown'), message: el('message'), results: el('results'),
    loading: el('loading'), error: el('error'),
  };
  let lastCount = null;
  let shownResults = false;
  return {
    els,
    ready() {
      els.loading.hidden = true;
    },
    error(err) {
      els.loading.hidden = true;
      els.error.hidden = false;
      els.error.textContent = `Dusk Circuit failed to start:\n${err && err.message ? err.message : err}`;
    },
    update(race, player) {
      const laps = race.laps;
      els.lap.textContent = `${Math.min(player.lap + 1, laps)}/${laps}`;
      const t = Math.max(0, (race.tick - (player.finished ? race.tick - player.finishTick : 0)) / 60 - 3);
      els.time.textContent = fmt(player.finished ? (player.finishTick - 180) / 60 : t);
      els.pos.textContent = ORD[player.rank - 1] || `${player.rank}th`;
      els.speed.textContent = String(Math.round(Math.abs(player.speed) * 3.6));
      if (race.phase === 'countdown') {
        const n = Math.ceil(race.countdownRemaining);
        els.countdown.hidden = false;
        if (n !== lastCount) {
          els.countdown.textContent = n > 0 ? String(n) : 'GO';
          lastCount = n;
        }
      } else if (race.tick < 180 + 50) {
        els.countdown.hidden = false;
        els.countdown.textContent = 'GO';
      } else {
        els.countdown.hidden = true;
      }
      if (player.finished && !shownResults) {
        shownResults = true;
        const rows = race.standings
          .map((k) => `<tr class="${k === player ? 'me' : ''}"><td>${ORD[k.rank - 1]}</td><td>${k.name}</td><td>${k.finished ? fmt((k.finishTick - 180) / 60) : '—'}</td></tr>`)
          .join('');
        els.results.innerHTML = `<h2>${ORD[player.rank - 1]} place</h2><table>${rows}</table><p style="opacity:.7;font-size:14px">Press R to race again</p>`;
        els.results.hidden = false;
      }
    },
    message(text) {
      els.message.hidden = !text;
      els.message.textContent = text || '';
    },
  };
}
