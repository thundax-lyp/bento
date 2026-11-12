import {
    cleanup,
    fireEvent,
    render,
    screen,
    within,
} from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { DiffPreview } from './ui';

afterEach(cleanup);

test('空补丁显示无变更，补丁中的 HTML 只作为文本呈现', () => {
    const view = render(<DiffPreview text="" />);
    expect(screen.getByText('这次任务没有文件变更。')).toBeTruthy();

    view.rerender(<DiffPreview text={'+<img src=x onerror=alert(1)>'} />);
    expect(screen.getByLabelText('逐行变更').textContent).toBe(
        '+<img src=x onerror=alert(1)>',
    );
    expect(screen.getByText('无法按文件显示此补丁。')).toBeTruthy();
    expect(screen.queryByRole('list', { name: '变更文件' })).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
});

test('逐文件审阅新增、修改和删除，并切回完整补丁', () => {
    const blocks = [
        'diff --git a/edit.txt b/edit.txt\nindex 90be1f3..294186e 100644\n--- a/edit.txt\n+++ b/edit.txt\n@@ -1 +1 @@\n-before\n+after\n',
        'diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex bc99ab0..0000000\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n\\ No newline at end of file\n',
        'diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..3e75765\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n',
    ];
    const full = blocks.join('');
    const view = render(<DiffPreview text={full} />);
    const preview = screen.getByLabelText('逐行变更');
    const buttons = within(
        screen.getByRole('list', { name: '变更文件' }),
    ).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
        '修改 edit.txt',
        '删除 gone.txt',
        '新增 new.txt',
    ]);
    expect(preview.textContent).toBe(full);
    for (const [index, button] of buttons.entries()) {
        fireEvent.click(button);
        expect(button.getAttribute('aria-pressed')).toBe('true');
        expect(preview.textContent).toBe(blocks[index]);
    }
    fireEvent.click(screen.getByRole('button', { name: '完整补丁' }));
    expect(preview.textContent).toBe(full);

    const simple =
        '--- "a/edit.txt"\n+++ "b/edit.txt"\n@@ -1 +1 @@\n-before\n+after\n';
    view.rerender(<DiffPreview text={simple} />);
    const simpleFile = screen.getByRole('button', { name: '修改 edit.txt' });
    fireEvent.click(simpleFile);
    expect(simpleFile.getAttribute('aria-pressed')).toBe('true');
    expect(preview.textContent).toBe(simple);
});
