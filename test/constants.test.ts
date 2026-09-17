import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LLM_MODEL, DEFAULT_PERSONA, JEV_MODEL, LLM_MODELS, PERSONA_COMMON, PERSONA_IDS,
  PERSONAS, PRICING, REPLY_MODEL, isPersonaId,
} from '../src/constants.ts';

test('UI に出す全モデルに単価がある', () => {
  // 単価が無いと costUsd が投げる。しかも投げるのは課金される呼び出しのあとになる。
  for (const model of LLM_MODELS) {
    assert.ok(PRICING[model], `${model} の単価が PRICING に無い`);
  }
});

test('既定モデルと jev にも単価がある', () => {
  assert.ok(LLM_MODELS.includes(DEFAULT_LLM_MODEL), '既定モデルが選択肢に含まれること');
  assert.ok(PRICING[JEV_MODEL], 'jev の単価があること');
});

test('生成モデルにも単価がある', () => {
  assert.ok(PRICING[REPLY_MODEL], `${REPLY_MODEL} の単価が PRICING に無い`);
});

test('人格は friendly と contrarian の2つ', () => {
  assert.deepEqual([...PERSONA_IDS], ['friendly', 'contrarian']);
  assert.deepEqual(Object.keys(PERSONAS), [...PERSONA_IDS]);
  assert.ok(PERSONA_IDS.includes(DEFAULT_PERSONA), '既定の人格が選択肢に含まれること');
});

test('人格には画面表記と指示文がある', () => {
  for (const id of PERSONA_IDS) {
    const persona = PERSONAS[id];
    assert.equal(persona.id, id);
    assert.ok(persona.label.includes(id), `${id}: 選択肢の表記に id が入っていない`);
    assert.ok(persona.text.trim().length > 0, `${id}: 指示文が空`);
  }
});

test('人格は互いに違う性格を指示する', () => {
  // 同じことを言う2つを並べても、人格を固定した比較にならない。
  assert.notEqual(PERSONAS.friendly.text, PERSONAS.contrarian.text);
  assert.match(PERSONAS.friendly.text, /肯定的/);
  assert.match(PERSONAS.contrarian.text, /皮肉|反論/);
  // 天邪鬼でも攻撃的・侮辱的・差別的にはならない、という歯止めを持つ。
  assert.match(PERSONAS.contrarian.text, /攻撃的/);
});

test('どちらの人格も性別を与えず、一人称と二人称を固定する', () => {
  for (const id of PERSONA_IDS) {
    const text = PERSONAS[id].text;
    assert.ok(text.includes(PERSONA_COMMON), `${id}: 共通の制約が入っていない`);
  }
  assert.match(PERSONA_COMMON, /性別/);
  assert.match(PERSONA_COMMON, /「私」/);
  assert.match(PERSONA_COMMON, /「あなた」/);
});

test('人格の指示文は返答の長さを指定しない', () => {
  // 長さは replyInstruction() が決める。両方に書くと食い違う。
  for (const id of PERSONA_IDS) {
    assert.doesNotMatch(PERSONAS[id].text, /文程度|文以内|[0-9]〜[0-9]文/, `${id}: 長さの指定が残っている`);
  }
});

test('isPersonaId は未知の名前を通さない', () => {
  assert.ok(isPersonaId('friendly'));
  assert.ok(isPersonaId('contrarian'));
  assert.ok(!isPersonaId('neutral'));
  assert.ok(!isPersonaId(''));
  assert.ok(!isPersonaId(undefined));
  // Object.prototype 由来の名前を人格として通さない。
  assert.ok(!isPersonaId('toString'));
});
