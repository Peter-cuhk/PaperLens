export function isAbortError(error: unknown) {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

export async function runWithProviderRecovery<T, TSettings extends { provider: string }>(options: {
  settings: TSettings;
  run: (settings: TSettings, repairError: string) => Promise<T>;
  onRepair?: (errorMessage: string) => void;
}) {
  try {
    return { value: await options.run(options.settings, ""), recovered: false };
  } catch (error) {
    if (isAbortError(error)) throw error;
    const errorMessage = error instanceof Error ? error.message : "AI 任务执行失败";
    options.onRepair?.(errorMessage);
    return {
      value: await options.run(options.settings, errorMessage),
      recovered: true,
    };
  }
}
