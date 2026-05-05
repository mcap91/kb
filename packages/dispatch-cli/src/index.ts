import { run } from './run.js';

const args = process.argv.slice(2);

run(args)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('Unexpected error:', err);
    process.exitCode = 1;
  });
