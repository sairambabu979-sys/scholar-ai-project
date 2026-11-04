/**
 * Runs once when the server process starts. Validating configuration here makes an unsafe
 * production configuration (mock mode, missing secrets, premature writes) stop the server at
 * startup instead of failing request by request.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getEnv, ConfigError } = await import("@scholar/config");
    try {
      getEnv();
    } catch (e) {
      if (e instanceof ConfigError) {
        console.error(e.message);
        process.exit(1);
      }
      throw e;
    }
  }
}
