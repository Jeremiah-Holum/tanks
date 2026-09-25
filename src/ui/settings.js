// Settings dialog: graphics, controls, audio, game. Edits a draft; APPLY stores it in the profile
// and calls opts.onSettings(settings) (and audio.setVolumes when an audio object was given).
import { h, clear, ICON, svg } from './dom.js';
import { DEFAULT_SETTINGS, newProfile } from '../meta/profile.js';

export function buildSettings(S) {
  const draft = structuredClone(S.profile.settings);
  draft.name = S.profile.name;
  const body = h('div.st-body');
  const tabs = h('div.st-tabs');
  let cur = 'graphics';

  const seg = (key, opts, obj = draft) => h('div.seg', opts.map(([v, l]) => h('button' + (obj[key] === v ? '.on' : ''), { onclick: (e) => {
    obj[key] = v; for (const b of e.currentTarget.parentNode.children) b.classList.toggle('on', b === e.currentTarget);
  } }, l)));
  const slider = (key, min, max, step, fmtv, obj = draft) => {
    const out = h('span.st-val', fmtv(obj[key]));
    const inp = h('input', { type: 'range', min, max, step, value: obj[key], oninput: (e) => { obj[key] = +e.target.value; out.textContent = fmtv(obj[key]); paint(); } });
    const paint = () => inp.style.setProperty('--p', ((obj[key] - min) / (max - min) * 100) + '%');
    paint();
    return h('div.st-slider', inp, out);
  };
  const toggle = (key, obj = draft) => h('button.st-toggle' + (obj[key] ? '.on' : ''), { onclick: (e) => { obj[key] = !obj[key]; e.currentTarget.classList.toggle('on', obj[key]); } }, h('i'));
  const row = (label, ctl, hint) => h('div.st-row', h('div.st-label', h('b', label), hint ? h('small', hint) : null), ctl);
  const pctf = (v) => Math.round(v * 100) + '%', mul = (v) => v.toFixed(2) + '×';

  const pages = {
    graphics: () => [
      row('Graphics quality', seg('quality', [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]), 'Auto picks a preset from your GPU and adapts to the frame rate.'),
      row('Render resolution', slider('renderScale', 0.5, 1, 0.05, pctf), 'Lower it for more frames per second on slow GPUs.'),
      row('Field of view', slider('fov', 55, 95, 1, (v) => v + '°'), 'Arcade camera, vertical.'),
      row('Show FPS counter', toggle('showFps')),
      row('Minimap size', seg('minimap', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']]), 'Press M in battle to toggle.')],
    controls: () => [
      row('Mouse sensitivity', slider('mouseSens', 0.2, 3, 0.05, mul), 'Arcade (third-person) camera.'),
      row('Sniper mode sensitivity', slider('sniperSens', 0.1, 2, 0.05, mul), 'Scaled further by zoom level.'),
      row('Invert vertical axis', toggle('invertY')),
      h('div.st-keys', h('h3.sf-h', 'Controls'), ...[['W A S D', 'Drive'], ['Mouse', 'Aim turret'], ['LMB', 'Fire'], ['RMB', 'Lock target / hold gun'],
        ['Shift / wheel', 'Sniper mode'], ['1 2 3', 'Select shell'], ['4 5 6', 'Consumables'], ['M', 'Minimap size'], ['Tab', 'Score panel'], ['Esc', 'Menu']]
        .map(([k, v]) => h('div.st-key', h('kbd', k), h('span', v))))],
    audio: () => [
      row('Master volume', slider('master', 0, 1, 0.01, pctf, draft.volumes)),
      row('Effects', slider('sfx', 0, 1, 0.01, pctf, draft.volumes)),
      row('Music', slider('music', 0, 1, 0.01, pctf, draft.volumes)),
      row('Crew voice', slider('voice', 0, 1, 0.01, pctf, draft.volumes)),
      row('Crew voice callouts', toggle('voice'), '"Penetration!", "We\'ve been spotted!" and friends.')],
    game: () => [
      row('Commander name', h('input.st-text', { value: draft.name, maxlength: 24, oninput: (e) => { draft.name = e.target.value.replace(/[^\w\-. ]/g, '').slice(0, 24); } })),
      row('Default battle size', seg('battleSize', [[15, '15 vs 15'], [7, '7 vs 7']])),
      row('Damage log in battle', toggle('damageLog')),
      h('div.st-danger', h('div', h('b', 'Reset progress'), h('small', 'Deletes all vehicles, experience, credits and statistics. Settings are kept.')),
        h('button.sf-btn.danger.small', { onclick: async () => {
          if (await S.confirm({ title: 'Reset progress?', body: [h('p', 'Everything you have earned will be lost. This cannot be undone.')], ok: 'Reset', danger: true })) {
            const np = newProfile(S.profile.name); np.settings = S.profile.settings;
            for (const k of Object.keys(S.profile)) delete S.profile[k];
            Object.assign(S.profile, np); S.thumbs.clear(); S.save(); close(); S.showHangar(); S.toast('Progress reset. Welcome, recruit.');
          }
        } }, 'Reset'))],
  };
  const render = () => {
    clear(tabs).append(...[['graphics', 'Graphics'], ['controls', 'Controls'], ['audio', 'Audio'], ['game', 'Game']]
      .map(([k, l]) => h('button.st-tab' + (k === cur ? '.on' : ''), { onclick: () => { cur = k; render(); } }, l)));
    clear(body).append(...pages[cur]());
  };
  render();
  const apply = () => {
    const name = (draft.name || '').trim();
    if (name) S.profile.name = name;
    delete draft.name;
    S.profile.settings = draft;
    S.battleSize = draft.battleSize === 7 ? 7 : 15;
    S.save();
    try { S.audio?.setVolumes?.({ ...draft.volumes, voiceOn: draft.voice }); } catch { /* optional */ }
    S.opts.onSettings?.(draft);
    close();
    if (S.current === 'hangar') S.showHangar();
    S.toast('Settings applied.', 'good');
  };
  const close = S.modal([
    h('div.sf-modal-head', h('h2', 'Settings'), h('button.sf-iconbtn', { onclick: () => close() }, svg(ICON.close))),
    tabs, body,
    h('div.sf-modal-foot',
      h('button.sf-btn.ghost', { onclick: () => { Object.assign(draft, structuredClone(DEFAULT_SETTINGS), { name: draft.name }); render(); } }, 'Defaults'),
      h('div', { style: { flex: 1 } }),
      h('button.sf-btn.ghost', { onclick: () => close() }, 'Cancel'),
      h('button.sf-btn.primary', { onclick: apply }, 'Apply')),
  ], { cls: 'settings' });
  return { close };
}
