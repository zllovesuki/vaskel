/** Holds a Web Lock until release; disposal before acquisition declines the grant. */
export function holdWebLock(
  locks: Pick<LockManager, "request">,
  name: string,
  options: Pick<LockOptions, "ifAvailable"> = {},
) {
  let released = false;
  let unlock: (() => void) | undefined;
  const acquired = new Promise<boolean>((resolve, reject) => {
    void locks
      .request(name, options, (lock) => {
        if (!lock || released) {
          resolve(false);
          return;
        }
        return new Promise<void>((release) => {
          unlock = release;
          resolve(true);
        });
      })
      .catch(reject);
  });
  return {
    acquired,
    release() {
      released = true;
      unlock?.();
    },
  };
}
