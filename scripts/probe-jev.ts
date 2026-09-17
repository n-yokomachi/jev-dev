import { experimental_evaluate as evaluate } from 'ai';

const result = await evaluate({
  model: 'typesafe-ai/jev',
  state: { user: 'だいたい君は前から強引なんだよ。', agent: '……そこは私の勇み足です。' },
  questions: {
    sorrow: {
      type: 'score',
      instructions: 'この会話を受けて、agent の感情のうち「悲しみ」はどう動いたか',
      criteria: ['強く下がった', '下がった', '変化なし', '上がった', '強く上がった'],
    },
  },
});

console.log(JSON.stringify({ answers: result.answers, usage: result.usage }, null, 2));
