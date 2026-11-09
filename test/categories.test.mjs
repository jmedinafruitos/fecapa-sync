import assert from 'node:assert/strict';
import test from 'node:test';
import { categoryOf, clubNameFromTeams, foldText, inferGender, normalizeCategory, teamBaseName } from '../dist/index.js';

test('foldText ignores accents, case and dots', () => {
  assert.equal(foldText('  Aleví  ÒR '), 'alevi or');
  assert.equal(foldText('PROVA, C.P.'), 'prova cp');
  assert.equal(foldText('2ª FASE'), '2a fase');
});

test('categories normalise from the names seen on FECAPA, any accent or case', () => {
  const cases = {
    'BENJAMÍ PLATA BARCELONA': 'benjami',
    ' BENJAMÍ  OR TARRAGONA': 'benjami',
    'BCN BENJAMÍ PLATA 1': 'benjami',
    'PREBENJAMI OR BARCELONA': 'prebenjami',
    'PREBENJAMÍ INICIACIÓ': 'prebenjami',
    '2ª FASE PREBENJAMI TGNA': 'prebenjami',
    'ALEVÍ PLATA': 'alevi',
    'INFANTIL BRONZE': 'infantil',
    'JUVENIL OR': 'juvenil',
    'JÚNIOR OR': 'junior',
    JUNIOR: 'junior',
    'COPA ELIT JÚNIOR': 'junior',
    'NACIONAL CATALANA MASCULINA': 'senior',
    'TERCERA CATALANA MASCULINA ': 'senior',
    'OK LIGA PLATA': 'senior',
    'LLIGA CATALANA PLATA': 'senior',
    'SUPERCOPA CATALANA FEMENINA': 'senior',
    'LLIGA CATALANA DE VETERANS': 'veterans',
    'MÀSTER 50 LLIGA CATALANA DE VETERANS': 'veterans',
    MINIFEM: 'minifem',
    FEM19: 'fem19',
    'FEM 17 OR ': 'fem17',
    'FEM 15 PLATA': 'fem15',
    'FEM13 PLATA I COPA CATALANA': 'fem13',
    'FEM11 (PRIMERA FASE)': 'fem11',
    'COPA DE LES ESTRELLES FEM13': 'fem13',
  };
  for (const [name, key] of Object.entries(cases)) assert.equal(categoryOf(name), key, name);
});

test('Catalan and Spanish spellings, and keys, are accepted', () => {
  for (const [query, key] of [
    ['Aleví', 'alevi'], ['Alevín', 'alevi'], ['alevi', 'alevi'], ['ALEVINES', 'alevi'],
    ['Benjamí', 'benjami'], ['Benjamín', 'benjami'], ['Prebenjamín', 'prebenjami'],
    ['Júnior', 'junior'], ['Sènior', 'senior'], ['Sénior', 'senior'], ['senior', 'senior'],
    ['Veteranos', 'veterans'], ['fem 13', 'fem13'], ['FEM13', 'fem13'], ['Fem13', 'fem13'], ['unknown', 'unknown'],
  ]) {
    assert.equal(categoryOf(query), key, query);
  }
});

test('unknown names map to "unknown" and keep the raw name, never dropped', () => {
  assert.equal(categoryOf('YOUTH GOLDEN CAT'), 'unknown');
  assert.equal(categoryOf('EL PARTIT DE LES ESTRELLES'), 'unknown');
  assert.equal(categoryOf(null), 'unknown');
  assert.deepEqual(normalizeCategory('YOUTH GOLDEN CAT', null), { category: 'unknown', categoryRaw: 'YOUTH GOLDEN CAT' });
  // The league name wins; SIDGAD's category is the fallback.
  assert.deepEqual(normalizeCategory('FEM 13 OR', 'ALEVÍ'), { category: 'fem13', categoryRaw: 'FEM 13 OR' });
  assert.deepEqual(normalizeCategory('LLIGA X', 'BENJAMI'), { category: 'benjami', categoryRaw: 'BENJAMI' });
});

test('gender rule: FEM category or "Femenina" in a name is female; everything else unknown, never male', () => {
  const female = { gender: 'female', genderSource: 'inferred' };
  const unknown = { gender: 'unknown', genderSource: 'inferred' };
  assert.deepEqual(inferGender('fem13'), female);
  assert.deepEqual(inferGender('minifem'), female);
  assert.deepEqual(inferGender('senior', ['NACIONAL CATALANA FEMENINA']), female);
  assert.deepEqual(inferGender('senior', ['nacional catalana femenína']), female);
  assert.deepEqual(inferGender('senior', ['OPEN GOLDENCAT FEMENÍ']), female);
  assert.deepEqual(inferGender('senior', ['NACIONAL CATALANA MASCULINA', 'MASCULINA']), unknown);
  assert.deepEqual(inferGender('benjami', ['BENJAMÍ PLATA BARCELONA', 'MIXTA']), unknown);
  assert.deepEqual(inferGender('unknown', ['FEMENINITAT']), unknown);
  assert.deepEqual(inferGender(null, []), unknown);
});

test('team suffixes are removed carefully to name a club', () => {
  assert.equal(teamBaseName('CP PROVA B'), 'CP PROVA');
  assert.equal(teamBaseName('CP PROVA  A '), 'CP PROVA');
  assert.equal(teamBaseName("CP PROVA 'C'"), 'CP PROVA');
  assert.equal(teamBaseName('RIBES INVENTAT A A'), 'RIBES INVENTAT');
  assert.equal(teamBaseName('CP PROVA HCP'), 'CP PROVA HCP');
  assert.equal(teamBaseName('X'), 'X');
  assert.deepEqual(clubNameFromTeams(['CP CONGRÉS A', 'CP CONGRES B', 'CP CONGRES', 'CP CONGRES D', 'ALTRE NOM']), {
    name: 'CP CONGRES', aliases: ['CP CONGRES', 'CP CONGRÉS', 'ALTRE NOM'],
  });
  // A tie between spellings prefers the accented one.
  assert.equal(clubNameFromTeams(['CP CONGRÉS A', 'CP CONGRES B']).name, 'CP CONGRÉS');
});
