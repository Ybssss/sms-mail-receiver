const { execSync } = require('child_process');

const REMOTE = 'https://github.com/Ybssss/sms-mail-receiver.git';
const message = process.argv[2] || 'update';
const init = process.argv.includes('--init');

function run(cmd) {
  execSync(cmd, { stdio: 'inherit', shell: true });
}

function ok(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore', shell: true });
    return true;
  } catch {
    return false;
  }
}

if (init) {
  run('git init');
}

run('git branch -M main');
run('git add -A');

if (ok('git diff --cached --quiet')) {
  console.log('Nothing to commit — pushing existing commits...');
} else {
  run(`git commit -m "${message}"`);
}

if (ok('git remote get-url origin')) {
  run(`git remote set-url origin ${REMOTE}`);
} else {
  run(`git remote add origin ${REMOTE}`);
}

run('git push -u origin main');
console.log('\nDone: https://github.com/Ybssss/sms-mail-receiver');
