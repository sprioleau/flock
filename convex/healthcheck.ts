import { query } from "./_generated/server";

export const status = query({
  args: {},
  handler: async () => {
    return { isHealthy: true, service: "flock" };
  },
});
