import process from 'node:process';

/**
 * Read a passphrase without echoing it.
 *
 * Automation can supply DOUBLOOM_PASSPHRASE, but environment variables are
 * visible to other processes owned by the same user, so interactive entry is
 * safer. Passphrases are never accepted on the command line, where they would
 * be visible in the process list.
 */
export async function readPassphrase(label, envName = 'DOUBLOOM_PASSPHRASE') {
  const fromEnvironment = envName ? process.env[envName] : undefined;
  if (fromEnvironment !== undefined) {
    if (fromEnvironment.length === 0) {
      throw new Error(`${envName} is set but empty`);
    }
    return fromEnvironment;
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      'no terminal available for the passphrase; set DOUBLOOM_PASSPHRASE for non-interactive use',
    );
  }

  process.stderr.write(label);

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = '';
    let settled = false;

    const cleanup = () => {
      stdin.off('data', onData);
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();
    };

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      process.stderr.write('\n');
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') {
          finish(null);
          return;
        }
        if (character === '\u0003') {
          finish(new Error('passphrase entry cancelled'));
          return;
        }
        if (character === '\u0004') {
          if (value.length === 0) {
            finish(new Error('passphrase entry cancelled'));
          } else {
            finish(null);
          }
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stderr.write('\b \b');
          }
          continue;
        }
        if (character >= ' ') {
          value += character;
          process.stderr.write('*');
        }
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}
