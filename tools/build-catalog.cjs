'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const manifest = require('../data/catalog-source.json');
const root = path.resolve(__dirname, '..');
const cacheIndex = process.argv.indexOf('--cache');
const cache = cacheIndex >= 0 ? path.resolve(process.argv[cacheIndex + 1])
  : path.join(root, '.cache', 'genshin-db', manifest.revision);
const colors = {'雷': '#8972b2', '水': '#428cac', '火': '#c56b55', '风': '#499b87',
  '草': '#829b43', '岩': '#b49438', '冰': '#62a5b3'};

async function source(relative) {
  const destination = path.join(cache, relative);
  try { return JSON.parse(await fs.readFile(destination, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch(`https://raw.githubusercontent.com/theBowja/genshin-db/${manifest.revision}/src/data/${relative}`);
  if (!response.ok) throw new Error(`${relative}: HTTP ${response.status}`);
  const value = await response.json();
  await fs.mkdir(path.dirname(destination), {recursive: true});
  await fs.writeFile(destination, JSON.stringify(value));
  return value;
}

function options(talent, parameters, pattern) {
  return (talent?.attributes?.labels || []).flatMap(label => {
    const [name, template = ''] = label.split('|');
    if (!pattern.test(name)) return [];
    return [...template.matchAll(/\{(param\d+)(?::[^}]*)?\}/g)].flatMap(match => {
      const value = parameters?.[match[1]]?.[0];
      return Number.isFinite(value) && value >= 0 ? [{name, ms: Math.round(value * 1000)}] : [];
    });
  });
}

async function main() {
  const [images, talentImages, parameters] = await Promise.all([
    source('image/characters.json'), source('image/talents.json'), source('stats/talents.json')
  ]);
  const asset = filename => filename ? `https://enka.network/ui/${filename}.png` : '';
  const characters = [];
  for (const filename of manifest.characters) {
    const slug = filename.slice(0, -5);
    const record = await source(`ChineseSimplified/characters/${filename}`);
    const talent = await source(`ChineseSimplified/talents/${filename}`);
    const pictures = talentImages[slug] || {};
    const skills = ['combat2', 'combat3'].map((slot, index) => {
      const value = talent[slot];
      const cooldownOptions = options(value, parameters[slug]?.[slot], /冷却时间|冷却时长/);
      const effectOptions = options(value, parameters[slug]?.[slot], /持续时间|持续时长/);
      return {id: index ? 'burst' : 'skill', key: index ? 'Q' : 'E', name: value?.name || (index ? '元素爆发' : '元素战技'),
        icon: asset(pictures[`filename_${slot}`]), foregroundMs: index ? 1800 : 900,
        cooldownMs: cooldownOptions.length ? Math.min(...cooldownOptions.map(item => item.ms)) : 0,
        effectMs: effectOptions.length ? Math.max(...effectOptions.map(item => item.ms)) : 0,
        effectPolicy: /(?:退场|离场|切换角色)[^\n。]*(?:解除|消失|结束)/.test(value?.description || '') ? 'onfield' : 'persist',
        description: value?.description || '', cooldownOptions, effectOptions};
    });
    skills.push({id: 'attack', key: 'A', name: talent.combat1?.name || '普通攻击',
      icon: asset(pictures.filename_combat1), foregroundMs: 2000, cooldownMs: 0, effectMs: 0, effectPolicy: 'persist', description: ''});
    skills.push({id: 'charge', key: '重击', name: '重击', icon: asset(pictures.filename_combat1),
      foregroundMs: 1200, cooldownMs: 0, effectMs: 0, effectPolicy: 'persist', description: ''});
    characters.push({id: String(record.id), name: record.name, aliases: [record.name, slug],
      element: record.elementText, weapon: record.weaponText, rarity: record.rarity,
      color: colors[record.elementText] || '#6b7b8b', avatar: asset(images[slug]?.filename_icon), skills});
  }
  characters.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const catalog = {version: 1, repository: 'theBowja/genshin-db', revision: manifest.revision,
    license: 'MIT', timingBasis: 'Planning estimates; unknown cooldowns and casting locks require calibration.', characters};
  await fs.writeFile(path.join(root, 'catalog.js'),
    `/* Generated from genshin-db; see licenses/genshin-db-MIT.txt. */\n(function(root) {\n  const catalog = ${JSON.stringify(catalog)};\n  if (typeof module === 'object' && module.exports) module.exports = catalog;\n  else root.CombatCatalog = catalog;\n})(globalThis);\n`);
  console.log(`Generated ${characters.length} characters from ${manifest.revision}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
