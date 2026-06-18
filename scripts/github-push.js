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

run('git fetch origin main');

if (ok('git rev-parse --verify origin/main')) {
  const upToDate =
    ok('git merge-base --is-ancestor origin/main HEAD') &&
    ok('git merge-base --is-ancestor HEAD origin/main');

  if (!upToDate) {
    console.log('Syncing with GitHub (keeping your local files on conflict)...');
    try {
      run('git merge origin/main --allow-unrelated-histories -X ours -m "sync with github"');
    } catch {
      if (ok('git diff --name-only --diff-filter=U')) {
        run('git checkout --ours README.md');
        run('git add README.md');
        run('git commit -m "sync with github"');
      }
    }
  }
}

run('git push -u origin main');
console.log('\nDone: https://github.com/Ybssss/sms-mail-receiver');
