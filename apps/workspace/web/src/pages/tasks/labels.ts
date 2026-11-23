export const taskStatusLabel = {
    preparing: '准备中',
    ready: '已就绪',
    failed: '准备失败',
    deleting: '正在删除',
};

export const retryReasonLabels: Record<string, string> = {
    task_closed: '任务已结案。',
    not_latest: '只能重试最近一次执行。',
    not_terminal: '当前执行尚不可重试。',
    needs_review: '上一次操作结果未确认。',
    stop_unconfirmed: '缺少可信停止证据，无法安全重试。',
    checkpoint_unavailable: '缺少完整检查点，无法安全重试。',
    environment_unavailable: '原运行环境暂不可用。',
    task_busy: '任务仍有尚未结束的执行。',
    task_not_ready: '任务尚未准备好。',
};

export const taskEventLabels = {
    user_message: '你',
    agent_reply: 'Agent',
    step: '步骤',
    command: '命令',
    check: '检查',
};

export const checkLabels = {
    passed: '通过',
    failed: '失败',
    not_run: '未运行',
    unavailable: '无法运行',
};
