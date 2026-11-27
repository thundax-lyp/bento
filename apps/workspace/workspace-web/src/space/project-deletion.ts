import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../api.ts';
import {
    deleteSpaceProject,
    getProjectDeletionImpact,
    spaceQuery,
} from './api.ts';

export function useProjectDeletion(
    account: string,
    id: string,
    projectState: string | undefined,
    projectError: unknown,
    refresh: () => Promise<void>,
) {
    const client = useQueryClient();
    const navigate = useNavigate();
    const deletionKey = JSON.stringify(['bento:project-delete', account, id]);
    const [confirmProject, setConfirmProject] = useState(false);
    const [confirmedProject, setConfirmedProject] = useState(
        () => sessionStorage.getItem(deletionKey) === '1',
    );
    const [projectAccepted, setProjectAccepted] = useState(false);
    const checkedMissing = useRef(false);
    const impact = useQuery({
        queryKey: ['account', account, 'project-deletion-impact', id],
        queryFn: ({ signal }) => getProjectDeletionImpact(id, signal),
        enabled: confirmProject || confirmedProject,
        retry: false,
    });
    const rememberDeletion = () => {
        sessionStorage.setItem(deletionKey, '1');
        setConfirmedProject(true);
    };
    const forgetDeletion = () => {
        sessionStorage.removeItem(deletionKey);
        setConfirmedProject(false);
    };
    const deleteProject = useMutation({
        mutationFn: () => deleteSpaceProject(id),
        async onSuccess(state) {
            if (state === 'deleted') {
                forgetDeletion();
                setProjectAccepted(false);
                await client.invalidateQueries({
                    queryKey: spaceQuery(account).queryKey,
                });
                await navigate('/workspaces');
                return;
            }
            setProjectAccepted(true);
            setConfirmProject(false);
            await refresh();
        },
        async onError(error) {
            if (error instanceof ApiError && error.status === 409) {
                forgetDeletion();
                setProjectAccepted(false);
                setConfirmProject(true);
            }
            if (!(error instanceof ApiError) || error.status !== 404) {
                await Promise.all([refresh(), impact.refetch()]);
            }
        },
    });
    const serverDeleting = projectState === 'deleting';
    const missing = [projectError, impact.error].some(
        (error) => error instanceof ApiError && error.status === 404,
    );
    useEffect(() => {
        if (serverDeleting) {
            sessionStorage.setItem(deletionKey, '1');
        }
    }, [serverDeleting, deletionKey]);
    const { mutate: checkDeletion, isPending: deletingRequest } = deleteProject;
    useEffect(() => {
        if (!missing) {
            checkedMissing.current = false;
            return;
        }
        if (
            deletingRequest ||
            checkedMissing.current ||
            (!confirmedProject && sessionStorage.getItem(deletionKey) !== '1')
        )
            return;
        checkedMissing.current = true;
        checkDeletion();
    }, [
        missing,
        deletingRequest,
        confirmedProject,
        deletionKey,
        checkDeletion,
    ]);

    return {
        confirmProject,
        setConfirmProject,
        confirmedProject,
        projectAccepted,
        deleteProject,
        impact,
        serverDeleting,
        missing,
        deletingRequest,
        checkDeletion,
        rememberDeletion,
    };
}
