import { vi } from "vitest";

/** Keep native SQL/results intact while modeling clock progress at completed I/O. */
export function afterIdentityQuery(
  database: D1Database,
  fragment: string,
  complete: () => void,
) {
  const normalize = (query: string) =>
    query.replaceAll('"', "").replace(/\s+/g, "").toLowerCase();
  const nativeSession = database.withSession.bind(database);
  return vi.spyOn(database, "withSession").mockImplementation((constraint) => {
    const session = nativeSession(constraint);
    const prepare = session.prepare.bind(session);
    session.prepare = (query) => {
      const statement = prepare(query);
      if (!normalize(query).includes(normalize(fragment))) return statement;
      const wrap = (value: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(value, {
          get(target, property, receiver) {
            if (property === "bind")
              return (...values: unknown[]) => wrap(target.bind(...values));
            if (
              property === "first" ||
              property === "run" ||
              property === "all"
            )
              return async (...args: unknown[]) => {
                const result: unknown = await Reflect.apply(
                  target[property],
                  target,
                  args,
                );
                complete();
                return result;
              };
            return Reflect.get(target, property, receiver);
          },
        });
      return wrap(statement);
    };
    return session;
  });
}
