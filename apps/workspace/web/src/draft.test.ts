import { afterEach, expect, test } from 'vitest';
import { loadDraft, prepareSubmission, saveDraft } from './draft';

afterEach(() => sessionStorage.clear());

test('响应未确认时，刷新后沿用原提交键，其他账号读不到草稿', () => {
    const sent = prepareSubmission({
        project: 'handbook',
        prompt: ' 补充安装说明 ',
    });
    saveDraft('demo', sent);
    expect(prepareSubmission(loadDraft('demo'))).toEqual(sent);
    expect(loadDraft('guest')).toEqual({ project: '', prompt: '' });
});
