export function lightWorkBudget({ milliseconds = 2, cells = 8192, visits = 32768, now = () => performance.now() } = {}) {
  let started;
  return {
    cells: 0, visits: 0,
    take(kind = "cells") {
      started ??= now();
      const maximum = kind === "cells" ? cells : visits;
      if (this[kind] >= maximum || (this[kind] % 32 === 0 && now() - started >= milliseconds)) return false;
      this[kind]++;
      return true;
    },
  };
}
