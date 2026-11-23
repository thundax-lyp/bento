import { onlineManager } from '@tanstack/react-query';
export const subscribeOnline = (listener: () => void) =>
    onlineManager.subscribe(listener);
export const isOnline = () => onlineManager.isOnline();
