export function message(error: unknown) {
    return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}
