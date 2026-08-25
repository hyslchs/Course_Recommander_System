import { QueryClient } from "@tanstack/react-query";

/**
 * One client per `App` instance, so a test never inherits another test's cache.
 *
 * The catalog behind these endpoints is regenerated once per semester import, so
 * a generous `staleTime` is what removes the duplicate requests the old
 * `useEffect` fetches produced; `refetchOnWindowFocus` would put them back.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60_000,
        gcTime: 30 * 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
      mutations: { retry: 0 },
    },
  });
}
