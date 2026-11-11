import { cleanup, render, screen } from '@testing-library/react';
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
    expect(screen.queryByRole('img')).toBeNull();
});
