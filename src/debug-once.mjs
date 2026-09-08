import { run } from './sandbox.mjs';

const result = await run({ language: 'python', code: 'print("debug run")' });
console.log(JSON.stringify(result, null, 2));
