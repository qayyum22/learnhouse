import { useAssignments } from '@components/Contexts/Assignments/AssignmentContext';
import { useAssignmentsTask, useAssignmentsTaskDispatch } from '@components/Contexts/Assignments/AssignmentsTaskContext';
import { useLHSession } from '@components/Contexts/LHSessionContext';
import AssignmentBoxUI from '@components/Objects/Activities/Assignment/AssignmentBoxUI';
import { getAssignmentTask, getAssignmentTaskSubmissionsMe, getAssignmentTaskSubmissionsUser, handleAssignmentTaskSubmission, updateAssignmentTask } from '@services/courses/assignments';
import { evaluateSocraticAttempt, SocraticHintTier, SocraticPriorAttempt } from '@services/ai/ai';
import { ArrowRight, BookOpenCheck, BrainCircuit, Check, ChevronDown, ChevronUp, Compass, Eye, HelpCircle, Info, Lightbulb, ListOrdered, Loader2, Minus, PlusCircle, Shapes, Sparkles, Target, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from 'react-i18next';

const MAX_TUTOR_ATTEMPTS = 3;
const TUTOR_TIERS: SocraticHintTier[] = ['conceptual', 'procedural', 'structural'];

type SocraticStep = {
    stepUUID: string;
    guidingQuestion: string;
    expectedInsight: string;
    workedSolution: string;
    hint: string;
};

type SocraticSchema = {
    problemStatement: string;
    learningObjective: string;
    tutorEnabled?: boolean;
    steps: SocraticStep[];
};

type TutorAttempt = {
    response: string;
    correct: boolean;
    tier: SocraticHintTier | null;
    guidance: string | null;
};

type TutorState = {
    attempts: TutorAttempt[];
    outcome: 'pending' | 'success' | 'failed';
    workedSolution?: string | null;
};

type SocraticSubmission = {
    stepUUID: string;
    response: string;
    hintUsed?: boolean;
    tutor?: TutorState;
};

type SocraticSubmitSchema = {
    problem: SocraticSchema;
    responses: SocraticSubmission[];
    assignment_task_submission_uuid?: string;
};

type TaskSocraticObjectProps = {
    view: 'teacher' | 'student' | 'grading' | 'custom-grading';
    assignmentTaskUUID?: string;
    user_id?: string;
};

function emptyStep(): SocraticStep {
    return { stepUUID: 'step_' + uuidv4(), guidingQuestion: '', expectedInsight: '', workedSolution: '', hint: '' };
}

function emptyProblem(): SocraticSchema {
    return { problemStatement: '', learningObjective: '', tutorEnabled: true, steps: [emptyStep()] };
}

function normalizeProblem(raw: any): SocraticSchema {
    const base = emptyProblem();
    return {
        ...base,
        ...raw,
        tutorEnabled: raw?.tutorEnabled ?? base.tutorEnabled,
        steps: (raw?.steps ?? base.steps).map((s: any) => ({
            ...emptyStep(),
            ...s,
            stepUUID: s?.stepUUID ?? 'step_' + uuidv4(),
            workedSolution: s?.workedSolution ?? '',
        })),
    };
}

function normalizeSubmission(raw: any, fallbackProblem?: SocraticSchema): SocraticSubmitSchema {
    const normalizedProblem = normalizeProblem(raw?.problem ?? fallbackProblem ?? emptyProblem());
    return {
        problem: normalizedProblem,
        assignment_task_submission_uuid: raw?.assignment_task_submission_uuid,
        responses: (raw?.responses ?? []).map((r: any) => ({
            stepUUID: r?.stepUUID ?? 'step_' + uuidv4(),
            response: r?.response ?? '',
            hintUsed: !!r?.hintUsed,
            tutor: r?.tutor
                ? {
                    attempts: Array.isArray(r.tutor.attempts) ? r.tutor.attempts : [],
                    outcome: r.tutor.outcome === 'success' || r.tutor.outcome === 'failed' ? r.tutor.outcome : 'pending',
                    workedSolution: r.tutor.workedSolution ?? null,
                }
                : undefined,
        })),
    };
}

function emptyTutorState(): TutorState {
    return { attempts: [], outcome: 'pending', workedSolution: null };
}

function TaskSocraticObject({ view, assignmentTaskUUID, user_id }: TaskSocraticObjectProps) {
    const { t } = useTranslation();
    const session = useLHSession() as any;
    const access_token = session?.data?.tokens?.access_token;
    const assignmentTaskState = useAssignmentsTask() as any;
    const assignmentTaskStateHook = useAssignmentsTaskDispatch() as any;
    const assignment = useAssignments() as any;

    /* TEACHER VIEW CODE */
    const [problem, setProblem] = useState<SocraticSchema>(emptyProblem());

    const updateProblemField = (field: 'problemStatement' | 'learningObjective', value: string) => {
        setProblem({ ...problem, [field]: value });
    };

    const updateStepField = (sIndex: number, field: 'guidingQuestion' | 'expectedInsight' | 'workedSolution' | 'hint', value: string) => {
        const updatedSteps = [...problem.steps];
        updatedSteps[sIndex] = { ...updatedSteps[sIndex], [field]: value };
        setProblem({ ...problem, steps: updatedSteps });
    };

    const addStep = () => {
        setProblem({ ...problem, steps: [...problem.steps, emptyStep()] });
    };

    const removeStep = (sIndex: number) => {
        if (problem.steps.length <= 1) {
            toast.error(t('dashboard.assignments.editor.task_types.socratic_problem.errors.last_step'));
            return;
        }
        const updatedSteps = [...problem.steps];
        updatedSteps.splice(sIndex, 1);
        setProblem({ ...problem, steps: updatedSteps });
    };

    const moveStep = (sIndex: number, direction: -1 | 1) => {
        const target = sIndex + direction;
        if (target < 0 || target >= problem.steps.length) return;
        const updatedSteps = [...problem.steps];
        const [moved] = updatedSteps.splice(sIndex, 1);
        updatedSteps.splice(target, 0, moved);
        setProblem({ ...problem, steps: updatedSteps });
    };

    const saveFC = async () => {
        if (!problem.problemStatement.trim()) {
            toast.error(t('dashboard.assignments.editor.task_types.socratic_problem.errors.problem_statement_required'));
            return;
        }
        if (problem.steps.length === 0 || problem.steps.every((s) => !s.guidingQuestion.trim())) {
            toast.error(t('dashboard.assignments.editor.task_types.socratic_problem.errors.steps_required'));
            return;
        }
        if (problem.steps.some((s) => !s.guidingQuestion.trim())) {
            toast.error(t('dashboard.assignments.editor.task_types.socratic_problem.errors.guiding_question_required'));
            return;
        }
        if (problem.tutorEnabled) {
            if (problem.steps.some((s) => !s.expectedInsight.trim())) {
                toast.error(t('dashboard.assignments.editor.task_types.socratic_problem.tutor.errors.expected_insight_required'));
                return;
            }
            if (problem.steps.some((s) => !s.workedSolution.trim())) {
                toast.error(t('dashboard.assignments.editor.task_types.socratic_problem.tutor.errors.worked_solution_required'));
                return;
            }
        }
        const values = {
            contents: {
                problem,
            },
        };
        const res = await updateAssignmentTask(values, assignmentTaskState.assignmentTask.assignment_task_uuid, assignment.assignment_object.assignment_uuid, access_token);
        if (res) {
            assignmentTaskStateHook({ type: 'reload' });
            toast.success(t('dashboard.assignments.editor.toasts.task_saved'));
        } else {
            toast.error(t('dashboard.assignments.editor.toasts.task_save_error'));
        }
    };
    /* TEACHER VIEW CODE */

    /* STUDENT VIEW CODE */
    const [userSubmission, setUserSubmission] = useState<SocraticSubmitSchema>({
        problem: emptyProblem(),
        responses: [],
    });
    const [initialUserSubmission, setInitialUserSubmission] = useState<SocraticSubmitSchema>({
        problem: emptyProblem(),
        responses: [],
    });
    const [showSavingDisclaimer, setShowSavingDisclaimer] = useState<boolean>(false);
    const [assignmentTaskOutsideProvider, setAssignmentTaskOutsideProvider] = useState<any>(null);
    const [activeStepIndex, setActiveStepIndex] = useState<number>(0);
    const [revealedInsights, setRevealedInsights] = useState<Record<string, boolean>>({});

    const getSubmissionEntry = (stepUUID: string) =>
        userSubmission.responses.find((r) => r.stepUUID === stepUUID);

    const getResponseForStep = (stepUUID: string) =>
        getSubmissionEntry(stepUUID)?.response || '';

    const isHintUsed = (stepUUID: string) =>
        !!getSubmissionEntry(stepUUID)?.hintUsed;

    const upsertSubmissionEntry = (stepUUID: string, patch: Partial<SocraticSubmission>) => {
        const updated = [...userSubmission.responses];
        const idx = updated.findIndex((r) => r.stepUUID === stepUUID);
        if (idx !== -1) {
            updated[idx] = { ...updated[idx], ...patch };
        } else {
            updated.push({ stepUUID, response: '', hintUsed: false, ...patch });
        }
        setUserSubmission({ ...userSubmission, responses: updated });
    };

    const setResponseForStep = (stepUUID: string, value: string) => {
        upsertSubmissionEntry(stepUUID, { response: value });
    };

    const markHintUsed = (stepUUID: string) => {
        upsertSubmissionEntry(stepUUID, { hintUsed: true });
    };

    /* TUTOR STATE */
    const [evaluating, setEvaluating] = useState<boolean>(false);
    const [draftResponse, setDraftResponse] = useState<string>('');

    const getTutorState = (stepUUID: string): TutorState =>
        getSubmissionEntry(stepUUID)?.tutor ?? emptyTutorState();

    const isStepResolved = (stepUUID: string) => {
        const ts = getTutorState(stepUUID);
        return ts.outcome === 'success' || ts.outcome === 'failed';
    };

    const submitTutorAttempt = async (step: SocraticStep) => {
        const ts = getTutorState(step.stepUUID);
        if (isStepResolved(step.stepUUID) || evaluating) return;
        if (!draftResponse.trim()) {
            toast.error(t('dashboard.assignments.editor.task_types.socratic_problem.errors.answer_first'));
            return;
        }
        const attemptNumber = ts.attempts.length + 1;
        if (attemptNumber > MAX_TUTOR_ATTEMPTS) return;

        const priorAttempts: SocraticPriorAttempt[] = ts.attempts
            .filter((a) => !a.correct && a.tier && a.guidance)
            .map((a) => ({ response: a.response, tier: a.tier as SocraticHintTier, guidance: a.guidance as string }));

        setEvaluating(true);
        try {
            const res = await evaluateSocraticAttempt(
                {
                    assignment_task_uuid: assignmentTaskUUID as string,
                    step_uuid: step.stepUUID,
                    attempt_number: attemptNumber,
                    learner_response: draftResponse,
                    prior_attempts: priorAttempts,
                },
                access_token
            );
            if (!res.success) {
                toast.error((res.data as any)?.detail || t('dashboard.assignments.editor.task_types.socratic_problem.tutor.errors.evaluation_failed'));
                return;
            }
            const verdict = res.data;
            const newAttempt: TutorAttempt = {
                response: draftResponse,
                correct: verdict.is_correct,
                tier: verdict.tier,
                guidance: verdict.guidance,
            };
            const nextState: TutorState = {
                attempts: [...ts.attempts, newAttempt],
                outcome:
                    verdict.outcome === 'success'
                        ? 'success'
                        : verdict.outcome === 'failed'
                            ? 'failed'
                            : 'pending',
                workedSolution: verdict.worked_solution ?? ts.workedSolution ?? null,
            };
            const updatedResponses = [...userSubmission.responses];
            const idx = updatedResponses.findIndex((r) => r.stepUUID === step.stepUUID);
            const nextEntry = {
                ...(idx !== -1 ? updatedResponses[idx] : { stepUUID: step.stepUUID, response: '', hintUsed: false }),
                response: draftResponse,
                tutor: nextState,
            };
            if (idx !== -1) {
                updatedResponses[idx] = nextEntry;
            } else {
                updatedResponses.push(nextEntry);
            }
            const updatedSubmission = {
                ...userSubmission,
                assignment_task_submission_uuid:
                    verdict.assignment_task_submission_uuid ?? userSubmission.assignment_task_submission_uuid,
                responses: updatedResponses,
            };
            setUserSubmission(updatedSubmission);
            setInitialUserSubmission(updatedSubmission);
            setShowSavingDisclaimer(false);
            setDraftResponse('');
        } finally {
            setEvaluating(false);
        }
    };

    const canAdvanceFrom = (sIndex: number) => {
        const step = problem.steps[sIndex];
        if (!step) return false;
        if (problem.tutorEnabled) return isStepResolved(step.stepUUID);
        return getResponseForStep(step.stepUUID).trim().length > 0;
    };

    const goToNextStep = () => {
        if (!canAdvanceFrom(activeStepIndex)) {
            toast.error(
                problem.tutorEnabled
                    ? t('dashboard.assignments.editor.task_types.socratic_problem.tutor.errors.resolve_first')
                    : t('dashboard.assignments.editor.task_types.socratic_problem.errors.answer_first')
            );
            return;
        }
        if (activeStepIndex < problem.steps.length - 1) {
            setActiveStepIndex(activeStepIndex + 1);
            setDraftResponse('');
        }
    };

    async function getAssignmentTaskUI() {
        if (assignmentTaskUUID) {
            const res = await getAssignmentTask(assignmentTaskUUID, access_token);
            if (res.success) {
                setAssignmentTaskOutsideProvider(res.data);
                if (res.data.contents?.problem) {
                    const normalized = normalizeProblem(res.data.contents.problem);
                    setProblem(normalized);
                    return normalized;
                }
            }
        }
        return undefined;
    }

    async function getAssignmentTaskSubmissionFromUserUI(loadedProblem?: SocraticSchema) {
        if (assignmentTaskUUID) {
            const res = await getAssignmentTaskSubmissionsMe(assignmentTaskUUID, assignment.assignment_object.assignment_uuid, access_token);
            if (res.success) {
                const loaded = normalizeSubmission({
                    ...res.data.task_submission,
                    assignment_task_submission_uuid: res.data.assignment_task_submission_uuid,
                }, loadedProblem ?? problem);
                setUserSubmission(loaded);
                setInitialUserSubmission(loaded);
                // Resume at the first step (in authored order) that does not yet have a response
                // (or, when the tutor is enabled, that is not yet resolved).
                const effectiveProblem = loadedProblem ?? problem;
                const steps = effectiveProblem.steps || [];
                const responses: SocraticSubmission[] = res.data.task_submission?.responses || [];
                const isFinished = (s: SocraticStep) => {
                    const r = responses.find((x) => x.stepUUID === s.stepUUID);
                    if (effectiveProblem.tutorEnabled) {
                        return r?.tutor?.outcome === 'success' || r?.tutor?.outcome === 'failed';
                    }
                    return !!r?.response?.trim();
                };
                const firstUnfinished = steps.findIndex((s) => !isFinished(s));
                setActiveStepIndex(
                    firstUnfinished === -1 ? Math.max(0, steps.length - 1) : firstUnfinished
                );
            }
        }
    }

    useEffect(() => {
        const hasChanges = JSON.stringify(initialUserSubmission.responses) !== JSON.stringify(userSubmission.responses);
        setShowSavingDisclaimer(hasChanges);
    }, [userSubmission, initialUserSubmission.responses]);

    const submitFC = async () => {
        if (userSubmission.responses.filter((r) => r.response.trim()).length === 0) {
            toast.error(t('dashboard.assignments.editor.task_types.socratic_problem.errors.answer_first'));
            return;
        }
        const values = {
            assignment_task_submission_uuid: userSubmission.assignment_task_submission_uuid || null,
            task_submission: { problem, responses: userSubmission.responses },
            grade: 0,
            task_submission_grade_feedback: '',
        };
        if (assignmentTaskUUID) {
            const res = await handleAssignmentTaskSubmission(values, assignmentTaskUUID, assignment.assignment_object.assignment_uuid, access_token);
            if (res) {
                assignmentTaskStateHook({ type: 'reload' });
                toast.success(t('dashboard.assignments.editor.toasts.task_saved'));
                const updated = {
                    ...userSubmission,
                    problem,
                    assignment_task_submission_uuid: res.data?.assignment_task_submission_uuid || userSubmission.assignment_task_submission_uuid,
                };
                setUserSubmission(updated);
                setInitialUserSubmission(updated);
                setShowSavingDisclaimer(false);
            } else {
                toast.error(t('dashboard.assignments.editor.toasts.task_save_error'));
            }
        }
    };
    /* STUDENT VIEW CODE */

    /* GRADING VIEW CODE */
    const [userSubmissionObject, setUserSubmissionObject] = useState<any>(null);

    async function getAssignmentTaskSubmissionFromIdentifiedUserUI() {
        if (assignmentTaskUUID && user_id) {
            const res = await getAssignmentTaskSubmissionsUser(assignmentTaskUUID, user_id, assignment.assignment_object.assignment_uuid, access_token);
            if (res.success) {
                const loaded = normalizeSubmission({
                    ...res.data.task_submission,
                    assignment_task_submission_uuid: res.data.assignment_task_submission_uuid,
                }, problem);
                setUserSubmission(loaded);
                setInitialUserSubmission(loaded);
                setUserSubmissionObject(res.data);
            }
        }
    }

    const gradeCustomFC = async (grade: number) => {
        if (!assignmentTaskUUID) return;
        const max = assignmentTaskOutsideProvider?.max_grade_value || 100;
        if (Number.isNaN(grade) || grade < 0 || grade > max) {
            toast.error('Grade must be between 0 and ' + max);
            return;
        }
        const values = {
            assignment_task_submission_uuid: userSubmission.assignment_task_submission_uuid,
            task_submission: { problem, responses: userSubmission.responses || [] },
            grade,
            task_submission_grade_feedback: 'Graded manually',
        };
        const res = await handleAssignmentTaskSubmission(values, assignmentTaskUUID, assignment.assignment_object.assignment_uuid, access_token);
        if (res) {
            getAssignmentTaskSubmissionFromIdentifiedUserUI();
            toast.success(`Task graded successfully with ${grade} points`);
        } else {
            toast.error('Error grading task, please retry later.');
        }
    };
    /* GRADING VIEW CODE */

    useEffect(() => {
        assignmentTaskStateHook({
            setSelectedAssignmentTaskUUID: assignmentTaskUUID,
        });
        if (view === 'teacher') {
            if (assignmentTaskState.assignmentTask.contents?.problem) {
                setProblem(normalizeProblem(assignmentTaskState.assignmentTask.contents.problem));
            }
        } else if (view === 'student') {
            getAssignmentTaskUI().then((loadedProblem) => {
                getAssignmentTaskSubmissionFromUserUI(loadedProblem);
            });
        } else if (view === 'grading' || view === 'custom-grading') {
            getAssignmentTaskUI();
            getAssignmentTaskSubmissionFromIdentifiedUserUI();
        }
    }, [assignmentTaskState, assignment, assignmentTaskStateHook, access_token, assignmentTaskUUID, view, user_id]);

    /* --------------- RENDER --------------- */

    if (view === 'teacher') {
        return (
            <AssignmentBoxUI saveFC={saveFC} view={view} type="socratic">
                <div className="flex flex-col space-y-4">
                    {/* Problem setup */}
                    <div className="flex flex-col space-y-2 p-3 bg-white rounded-md nice-shadow">
                        <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 flex items-center space-x-1.5">
                            <Target size={13} />
                            <span>{t('dashboard.assignments.editor.task_types.socratic_problem.learning_objective')}</span>
                        </label>
                        <input
                            value={problem.learningObjective}
                            onChange={(e) => updateProblemField('learningObjective', e.target.value)}
                            placeholder={t('dashboard.assignments.editor.task_types.socratic_problem.learning_objective_placeholder')}
                            className="w-full px-3 py-1.5 text-neutral-600 bg-[#00008b00] border-2 border-gray-200 rounded-md border-dotted text-sm font-bold"
                        />
                        <label className="flex items-center justify-between space-x-2 p-2 -mx-1 rounded-md bg-indigo-50/60 border border-indigo-100 cursor-pointer">
                            <span className="flex items-center space-x-1.5 text-xs font-semibold text-indigo-800">
                                <BrainCircuit size={13} />
                                <span>{t('dashboard.assignments.editor.task_types.socratic_problem.tutor.enable_label')}</span>
                            </span>
                            <input
                                type="checkbox"
                                checked={!!problem.tutorEnabled}
                                onChange={(e) => setProblem({ ...problem, tutorEnabled: e.target.checked })}
                                className="h-4 w-4 accent-indigo-600"
                            />
                        </label>
                        {problem.tutorEnabled && (
                            <p className="text-[11px] leading-snug text-slate-500 px-1">
                                {t('dashboard.assignments.editor.task_types.socratic_problem.tutor.enable_hint')}
                            </p>
                        )}
                        <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 pt-1 flex items-center space-x-1.5">
                            <HelpCircle size={13} />
                            <span>{t('dashboard.assignments.editor.task_types.socratic_problem.problem_statement')}</span>
                        </label>
                        <textarea
                            value={problem.problemStatement}
                            onChange={(e) => updateProblemField('problemStatement', e.target.value)}
                            placeholder={t('dashboard.assignments.editor.task_types.socratic_problem.problem_statement_placeholder')}
                            rows={3}
                            className="w-full px-3 py-1.5 text-neutral-600 bg-[#00008b00] border-2 border-gray-200 rounded-md border-dotted text-sm font-medium resize-y"
                        />
                    </div>

                    {/* Guided steps */}
                    <div className="flex flex-col space-y-3">
                        {problem.steps.map((step, sIndex) => (
                            <div key={step.stepUUID} className="flex flex-col space-y-2 p-3 bg-white rounded-md nice-shadow">
                                <div className="flex items-center justify-between">
                                    <p className="text-xs font-bold text-indigo-700 uppercase tracking-wide">
                                        {t('dashboard.assignments.editor.task_types.socratic_problem.step_label', { number: sIndex + 1 })}
                                    </p>
                                    <div className="flex items-center space-x-1">
                                        <div
                                            className="w-[20px] flex-none flex items-center h-[20px] rounded-lg bg-slate-200/60 text-slate-500 hover:bg-slate-300 text-sm transition-all ease-linear cursor-pointer"
                                            onClick={() => moveStep(sIndex, -1)}
                                        >
                                            <ChevronUp size={12} className="mx-auto" />
                                        </div>
                                        <div
                                            className="w-[20px] flex-none flex items-center h-[20px] rounded-lg bg-slate-200/60 text-slate-500 hover:bg-slate-300 text-sm transition-all ease-linear cursor-pointer"
                                            onClick={() => moveStep(sIndex, 1)}
                                        >
                                            <ChevronDown size={12} className="mx-auto" />
                                        </div>
                                        <div
                                            className="w-[20px] flex-none flex items-center h-[20px] rounded-lg bg-slate-200/60 text-slate-500 hover:bg-slate-300 text-sm transition-all ease-linear cursor-pointer"
                                            onClick={() => removeStep(sIndex)}
                                        >
                                            <Minus size={12} className="mx-auto" />
                                        </div>
                                    </div>
                                </div>
                                <input
                                    value={step.guidingQuestion}
                                    onChange={(e) => updateStepField(sIndex, 'guidingQuestion', e.target.value)}
                                    placeholder={t('dashboard.assignments.editor.task_types.socratic_problem.guiding_question_placeholder')}
                                    className="w-full px-3 py-1 text-neutral-600 bg-[#00008b00] border-2 border-gray-200 rounded-md border-dotted text-sm font-bold"
                                />
                                <textarea
                                    value={step.expectedInsight}
                                    onChange={(e) => updateStepField(sIndex, 'expectedInsight', e.target.value)}
                                    placeholder={t('dashboard.assignments.editor.task_types.socratic_problem.expected_insight_placeholder')}
                                    rows={2}
                                    className="w-full px-3 py-1 text-neutral-600 bg-lime-50 border-2 border-lime-200 rounded-md border-dotted text-sm font-medium resize-y"
                                />
                                {problem.tutorEnabled && (
                                    <textarea
                                        value={step.workedSolution}
                                        onChange={(e) => updateStepField(sIndex, 'workedSolution', e.target.value)}
                                        placeholder={t('dashboard.assignments.editor.task_types.socratic_problem.tutor.worked_solution_placeholder')}
                                        rows={3}
                                        className="w-full px-3 py-1 text-neutral-700 bg-rose-50 border-2 border-rose-200 rounded-md border-dotted text-sm font-medium resize-y"
                                    />
                                )}
                                <input
                                    value={step.hint}
                                    onChange={(e) => updateStepField(sIndex, 'hint', e.target.value)}
                                    placeholder={t('dashboard.assignments.editor.task_types.socratic_problem.hint_placeholder')}
                                    className="w-full px-3 py-1 text-neutral-600 bg-blue-50 border-2 border-blue-200 rounded-md border-dotted text-xs"
                                />
                            </div>
                        ))}
                    </div>
                    {problem.steps.length <= 9 && (
                        <div className="flex justify-center mx-auto px-2">
                            <div
                                className="flex w-full my-2 py-2 px-4 bg-white text-slate text-xs rounded-md nice-shadow hover:shadow-xs cursor-pointer space-x-3 items-center transition duration-150 ease-linear"
                                onClick={addStep}
                            >
                                <PlusCircle size={14} className="inline-block" />
                                <span>{t('dashboard.assignments.editor.task_types.socratic_problem.add_step')}</span>
                            </div>
                        </div>
                    )}
                </div>
            </AssignmentBoxUI>
        );
    }

    if (!problem.problemStatement && problem.steps.every((s) => !s.guidingQuestion)) {
        return (
            <div className="flex flex-row space-x-2 text-sm items-center">
                <Info size={12} />
                <p>{t('dashboard.assignments.editor.task_types.socratic_problem.not_configured')}</p>
            </div>
        );
    }

    if (view === 'student') {
        const totalSteps = problem.steps.length;
        const answeredSteps = problem.steps.filter((s) =>
            problem.tutorEnabled ? isStepResolved(s.stepUUID) : getResponseForStep(s.stepUUID).trim()
        ).length;
        const progressPct = totalSteps > 0 ? Math.round((answeredSteps / totalSteps) * 100) : 0;
        const isLastStep = activeStepIndex >= totalSteps - 1;
        const currentStep = problem.steps[activeStepIndex];
        const currentTutor = currentStep ? getTutorState(currentStep.stepUUID) : emptyTutorState();
        const currentResolved = currentStep ? isStepResolved(currentStep.stepUUID) : false;
        const currentAttemptNumber = Math.min(currentTutor.attempts.length + 1, MAX_TUTOR_ATTEMPTS);

        return (
            <AssignmentBoxUI
                submitFC={problem.tutorEnabled ? undefined : submitFC}
                view={view}
                maxPoints={assignmentTaskOutsideProvider?.max_grade_value}
                showSavingDisclaimer={problem.tutorEnabled ? false : showSavingDisclaimer}
                type="socratic"
            >
                <div className="flex flex-col space-y-4">
                    {/* Problem header */}
                    <div className="flex flex-col space-y-2 p-4 bg-gradient-to-br from-indigo-50 to-white rounded-md nice-shadow">
                        {problem.learningObjective && (
                            <div className="flex items-center space-x-2 text-xs font-semibold text-indigo-700">
                                <Target size={13} />
                                <span>{problem.learningObjective}</span>
                            </div>
                        )}
                        <p className="text-sm font-medium text-slate-700 whitespace-pre-wrap leading-relaxed">{problem.problemStatement}</p>
                    </div>

                    {/* Progress */}
                    <div className="flex flex-col space-y-1">
                        <div className="flex justify-between text-xs text-slate-500 font-semibold">
                            <span>{t('dashboard.assignments.editor.task_types.socratic_problem.step_progress', { current: activeStepIndex + 1, total: totalSteps })}</span>
                            <span>{progressPct}%</span>
                        </div>
                        <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
                            <div className="h-full bg-indigo-500 transition-all ease-linear" style={{ width: `${progressPct}%` }} />
                        </div>
                    </div>

                    {/* Active guided step */}
                    {currentStep && (
                        <div className="flex flex-col space-y-3 p-4 bg-white rounded-md nice-shadow">
                            <div className="flex items-start space-x-2">
                                <HelpCircle size={16} className="text-indigo-600 flex-none mt-0.5" />
                                <p className="text-sm font-semibold text-slate-800">{currentStep.guidingQuestion}</p>
                            </div>

                            {problem.tutorEnabled ? (
                                <>
                                    <TutorAttemptJourney
                                        state={currentTutor}
                                        activeAttempt={currentResolved ? null : currentAttemptNumber}
                                    />

                                    {/* Prior guidance stack — each failed attempt's tutor feedback */}
                                    {currentTutor.attempts.map((a, i) =>
                                        !a.correct && a.guidance ? (
                                            <TutorGuidanceCard
                                                key={i}
                                                attemptNumber={i + 1}
                                                tier={a.tier}
                                                guidance={a.guidance}
                                                learnerResponse={a.response}
                                            />
                                        ) : null
                                    )}

                                    {/* Terminal states */}
                                    {currentTutor.outcome === 'success' && (
                                        <div className="flex items-start space-x-2 p-3 rounded-md bg-emerald-50 border border-emerald-200">
                                            <Check size={15} className="flex-none mt-0.5 text-emerald-700" />
                                            <div className="flex flex-col">
                                                <p className="text-xs font-bold uppercase tracking-wide text-emerald-800">
                                                    {t('dashboard.assignments.editor.task_types.socratic_problem.tutor.outcome_success')}
                                                </p>
                                                <p className="text-xs text-emerald-800">
                                                    {t('dashboard.assignments.editor.task_types.socratic_problem.tutor.outcome_success_detail', {
                                                        attempt: currentTutor.attempts.length,
                                                    })}
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                    {currentTutor.outcome === 'failed' && (
                                        <div className="flex flex-col space-y-2 p-3 rounded-md bg-rose-50 border border-rose-200">
                                            <div className="flex items-center space-x-2">
                                                <X size={15} className="flex-none text-rose-700" />
                                                <p className="text-xs font-bold uppercase tracking-wide text-rose-800">
                                                    {t('dashboard.assignments.editor.task_types.socratic_problem.tutor.outcome_failed')}
                                                </p>
                                            </div>
                                            <div className="flex flex-col space-y-1 p-2 rounded bg-white/70 border border-rose-100">
                                                <p className="flex items-center space-x-1.5 text-[10px] font-bold uppercase tracking-wide text-rose-700">
                                                    <BookOpenCheck size={12} />
                                                    <span>{t('dashboard.assignments.editor.task_types.socratic_problem.tutor.worked_solution')}</span>
                                                </p>
                                                <p className="text-xs text-slate-700 whitespace-pre-wrap leading-relaxed">
                                                    {currentTutor.workedSolution}
                                                </p>
                                            </div>
                                        </div>
                                    )}

                                    {/* Attempt input — hidden once the step is resolved */}
                                    {!currentResolved && (
                                        <>
                                            <textarea
                                                value={draftResponse}
                                                onChange={(e) => setDraftResponse(e.target.value)}
                                                placeholder={t('dashboard.assignments.editor.task_types.socratic_problem.response_placeholder')}
                                                rows={3}
                                                disabled={evaluating}
                                                className="w-full px-3 py-2 text-neutral-700 bg-[#00008b00] border-2 border-gray-200 rounded-md focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 text-sm font-medium transition-all resize-y disabled:opacity-60"
                                            />
                                            <div className="flex items-center justify-between">
                                                <p className="text-[11px] font-semibold text-slate-500">
                                                    {t('dashboard.assignments.editor.task_types.socratic_problem.tutor.attempts_remaining', {
                                                        remaining: MAX_TUTOR_ATTEMPTS - currentTutor.attempts.length,
                                                    })}
                                                </p>
                                                <button
                                                    type="button"
                                                    onClick={() => submitTutorAttempt(currentStep)}
                                                    disabled={evaluating || !draftResponse.trim()}
                                                    className="flex items-center space-x-1.5 text-xs font-semibold px-3 py-1.5 rounded-full bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed transition-all"
                                                >
                                                    {evaluating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                                                    <span>
                                                        {t('dashboard.assignments.editor.task_types.socratic_problem.tutor.check_attempt', {
                                                            attempt: currentAttemptNumber,
                                                            max: MAX_TUTOR_ATTEMPTS,
                                                        })}
                                                    </span>
                                                </button>
                                            </div>
                                        </>
                                    )}
                                </>
                            ) : (
                                <>
                                    <textarea
                                        value={getResponseForStep(currentStep.stepUUID)}
                                        onChange={(e) => setResponseForStep(currentStep.stepUUID, e.target.value)}
                                        placeholder={t('dashboard.assignments.editor.task_types.socratic_problem.response_placeholder')}
                                        rows={3}
                                        className="w-full px-3 py-2 text-neutral-700 bg-[#00008b00] border-2 border-gray-200 rounded-md focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 text-sm font-medium transition-all resize-y"
                                    />

                                    {/* Hint */}
                                    {currentStep.hint && (
                                        <div className="flex flex-col space-y-1">
                                            {!isHintUsed(currentStep.stepUUID) ? (
                                                <div
                                                    onClick={() => markHintUsed(currentStep.stepUUID)}
                                                    className="flex items-center space-x-1.5 text-xs font-semibold text-amber-700 cursor-pointer hover:text-amber-800 w-fit"
                                                >
                                                    <Lightbulb size={13} />
                                                    <span>{t('dashboard.assignments.editor.task_types.socratic_problem.reveal_hint')}</span>
                                                </div>
                                            ) : (
                                                <div className="flex items-start space-x-2 p-2 bg-amber-50 rounded-md text-xs text-amber-800">
                                                    <Lightbulb size={13} className="flex-none mt-0.5" />
                                                    <span>{currentStep.hint}</span>
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* Expected insight (revealable after answering) */}
                                    {currentStep.expectedInsight && canAdvanceFrom(activeStepIndex) && (
                                        <div className="flex flex-col space-y-1">
                                            {!revealedInsights[currentStep.stepUUID] ? (
                                                <div
                                                    onClick={() => setRevealedInsights({ ...revealedInsights, [currentStep.stepUUID]: true })}
                                                    className="flex items-center space-x-1.5 text-xs font-semibold text-emerald-700 cursor-pointer hover:text-emerald-800 w-fit"
                                                >
                                                    <Eye size={13} />
                                                    <span>{t('dashboard.assignments.editor.task_types.socratic_problem.reveal_insight')}</span>
                                                </div>
                                            ) : (
                                                <div className="flex items-start space-x-2 p-2 bg-emerald-50 rounded-md text-xs text-emerald-800">
                                                    <Eye size={13} className="flex-none mt-0.5" />
                                                    <span>{currentStep.expectedInsight}</span>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </>
                            )}

                            {/* Navigation */}
                            <div className="flex justify-between items-center pt-1">
                                <div
                                    onClick={() => {
                                        if (activeStepIndex > 0) {
                                            setActiveStepIndex(activeStepIndex - 1);
                                            setDraftResponse('');
                                        }
                                    }}
                                    className={`text-xs font-semibold px-3 py-1 rounded-full ${activeStepIndex > 0 ? 'text-slate-600 hover:bg-slate-100 cursor-pointer' : 'text-slate-300'}`}
                                >
                                    {t('dashboard.assignments.editor.task_types.socratic_problem.previous_step')}
                                </div>
                                {!isLastStep ? (
                                    <div
                                        onClick={goToNextStep}
                                        className={`flex items-center space-x-1.5 text-xs font-semibold px-3 py-1.5 rounded-full transition-all ${canAdvanceFrom(activeStepIndex) ? 'bg-indigo-600 text-white hover:bg-indigo-700 cursor-pointer' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}
                                    >
                                        <span>{t('dashboard.assignments.editor.task_types.socratic_problem.next_step')}</span>
                                        <ArrowRight size={13} />
                                    </div>
                                ) : (
                                    <div className="flex items-center space-x-1.5 text-xs font-semibold px-3 py-1.5 rounded-full bg-emerald-100 text-emerald-700">
                                        <Check size={13} />
                                        <span>{t('dashboard.assignments.editor.task_types.socratic_problem.final_step')}</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Answered steps recap */}
                    {answeredSteps > 0 && (
                        <div className="flex flex-col space-y-1.5">
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t('dashboard.assignments.editor.task_types.socratic_problem.your_reasoning')}</p>
                            {problem.steps.map((step, sIndex) => {
                                const resp = getResponseForStep(step.stepUUID);
                                const tutor = getTutorState(step.stepUUID);
                                const resolved = isStepResolved(step.stepUUID);
                                if (sIndex === activeStepIndex) return null;
                                if (problem.tutorEnabled ? !resolved : !resp.trim()) return null;
                                return (
                                    <div
                                        key={step.stepUUID}
                                        onClick={() => { setActiveStepIndex(sIndex); setDraftResponse(''); }}
                                        className="flex flex-col p-2 bg-slate-50 rounded-md text-xs cursor-pointer hover:bg-slate-100"
                                    >
                                        <div className="flex items-center justify-between">
                                            <p className="font-semibold text-slate-700">{sIndex + 1}. {step.guidingQuestion}</p>
                                            {problem.tutorEnabled && <TutorOutcomeBadge state={tutor} />}
                                        </div>
                                        <p className="text-slate-500 pl-3 line-clamp-2">{resp}</p>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </AssignmentBoxUI>
        );
    }

    // grading / custom-grading — open-ended responses are manually graded
    return (
        <AssignmentBoxUI
            gradeCustomFC={gradeCustomFC}
            view="custom-grading"
            currentPoints={userSubmissionObject?.grade}
            maxPoints={assignmentTaskOutsideProvider?.max_grade_value}
            type="socratic"
        >
            <div className="flex flex-col space-y-3">
                <div className="flex flex-col space-y-1 p-3 bg-gradient-to-br from-indigo-50 to-white rounded-md nice-shadow">
                    {problem.learningObjective && (
                        <div className="flex items-center space-x-2 text-xs font-semibold text-indigo-700">
                            <Target size={13} />
                            <span>{problem.learningObjective}</span>
                        </div>
                    )}
                    <p className="text-sm font-medium text-slate-700 whitespace-pre-wrap">{problem.problemStatement}</p>
                </div>
                {problem.steps.map((step, sIndex) => {
                    const resp = getResponseForStep(step.stepUUID);
                    const usedHint = isHintUsed(step.stepUUID);
                    const tutor = getSubmissionEntry(step.stepUUID)?.tutor;
                    return (
                        <div key={step.stepUUID} className="flex flex-col space-y-1.5 p-3 bg-white rounded-md nice-shadow">
                            <div className="flex items-center justify-between">
                                <p className="text-xs font-bold text-indigo-700 uppercase tracking-wide">
                                    {t('dashboard.assignments.editor.task_types.socratic_problem.step_label', { number: sIndex + 1 })}
                                </p>
                                {problem.tutorEnabled && tutor ? (
                                    <TutorOutcomeBadge state={tutor} />
                                ) : step.hint ? (
                                    <div
                                        className={`flex items-center space-x-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${usedHint ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'}`}
                                    >
                                        <Lightbulb size={11} />
                                        <span>
                                            {usedHint
                                                ? t('dashboard.assignments.editor.task_types.socratic_problem.hint_used')
                                                : t('dashboard.assignments.editor.task_types.socratic_problem.hint_not_used')}
                                        </span>
                                    </div>
                                ) : null}
                            </div>
                            <p className="text-sm font-semibold text-slate-800">{step.guidingQuestion}</p>
                            {problem.tutorEnabled && tutor && (
                                <TutorAttemptJourney state={tutor} activeAttempt={null} compact />
                            )}
                            <div className="p-2 bg-gray-50 rounded-md border border-gray-200">
                                <p className="text-[10px] font-semibold uppercase text-slate-400">{t('dashboard.assignments.editor.task_types.socratic_problem.student_response')}</p>
                                <p className="text-sm text-slate-700 whitespace-pre-wrap">{resp || '—'}</p>
                            </div>
                            {step.expectedInsight && (
                                <div className="p-2 bg-lime-50 rounded-md border border-lime-200">
                                    <p className="text-[10px] font-semibold uppercase text-lime-700">{t('dashboard.assignments.editor.task_types.socratic_problem.expected_insight')}</p>
                                    <p className="text-sm text-lime-800 whitespace-pre-wrap">{step.expectedInsight}</p>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </AssignmentBoxUI>
    );
}

/* ----------------------------------------------------------------------------
 * Tutor sub-components
 * ------------------------------------------------------------------------- */

const TIER_META: Record<
    SocraticHintTier,
    { Icon: React.ComponentType<{ size?: number; className?: string }>; labelKey: string; cardClass: string; pillClass: string }
> = {
    conceptual: {
        Icon: Compass,
        labelKey: 'dashboard.assignments.editor.task_types.socratic_problem.tutor.tier_conceptual',
        cardClass: 'bg-sky-50 border-sky-200 text-sky-900',
        pillClass: 'bg-sky-100 border-sky-300 text-sky-800',
    },
    procedural: {
        Icon: ListOrdered,
        labelKey: 'dashboard.assignments.editor.task_types.socratic_problem.tutor.tier_procedural',
        cardClass: 'bg-amber-50 border-amber-200 text-amber-900',
        pillClass: 'bg-amber-100 border-amber-300 text-amber-800',
    },
    structural: {
        Icon: Shapes,
        labelKey: 'dashboard.assignments.editor.task_types.socratic_problem.tutor.tier_structural',
        cardClass: 'bg-violet-50 border-violet-200 text-violet-900',
        pillClass: 'bg-violet-100 border-violet-300 text-violet-800',
    },
};

function TutorAttemptJourney({
    state,
    activeAttempt,
    compact,
}: {
    state: TutorState;
    activeAttempt: number | null;
    compact?: boolean;
}) {
    const { t } = useTranslation();
    return (
        <div className={`flex items-stretch ${compact ? 'space-x-1' : 'space-x-1.5'}`}>
            {TUTOR_TIERS.map((tier, idx) => {
                const attemptNo = idx + 1;
                const attempt = state.attempts[idx];
                const meta = TIER_META[tier];
                const Icon = meta.Icon;

                let stateClass = 'bg-slate-50 border-slate-200 text-slate-400';
                let StatusIcon: React.ComponentType<{ size?: number; className?: string }> | null = null;
                if (attempt?.correct) {
                    stateClass = 'bg-emerald-50 border-emerald-300 text-emerald-800';
                    StatusIcon = Check;
                } else if (attempt && !attempt.correct) {
                    stateClass = 'bg-rose-50 border-rose-300 text-rose-800';
                    StatusIcon = X;
                } else if (activeAttempt === attemptNo) {
                    stateClass = `${meta.pillClass} ring-2 ring-offset-1 ring-indigo-300`;
                }

                return (
                    <div
                        key={tier}
                        className={`flex-1 flex items-center space-x-1.5 border rounded-md transition-all ${compact ? 'px-1.5 py-1' : 'px-2 py-1.5'} ${stateClass}`}
                    >
                        <Icon size={compact ? 11 : 13} className="flex-none" />
                        <div className="flex flex-col leading-tight min-w-0">
                            <span className={`font-bold uppercase tracking-wide ${compact ? 'text-[9px]' : 'text-[10px]'}`}>
                                {t('dashboard.assignments.editor.task_types.socratic_problem.tutor.attempt_of', {
                                    attempt: attemptNo,
                                    max: MAX_TUTOR_ATTEMPTS,
                                })}
                            </span>
                            <span className={`truncate ${compact ? 'text-[9px]' : 'text-[10px]'}`}>{t(meta.labelKey)}</span>
                        </div>
                        {StatusIcon && <StatusIcon size={compact ? 11 : 13} className="flex-none ml-auto" />}
                    </div>
                );
            })}
        </div>
    );
}

function TutorGuidanceCard({
    attemptNumber,
    tier,
    guidance,
    learnerResponse,
}: {
    attemptNumber: number;
    tier: SocraticHintTier | null;
    guidance: string;
    learnerResponse: string;
}) {
    const { t } = useTranslation();
    const meta = tier ? TIER_META[tier] : TIER_META.conceptual;
    const Icon = meta.Icon;
    return (
        <div className={`flex flex-col space-y-1.5 p-2.5 rounded-md border ${meta.cardClass}`}>
            <div className="flex items-center space-x-1.5">
                <Icon size={13} className="flex-none" />
                <p className="text-[10px] font-bold uppercase tracking-wide">
                    {t('dashboard.assignments.editor.task_types.socratic_problem.tutor.attempt_of', {
                        attempt: attemptNumber,
                        max: MAX_TUTOR_ATTEMPTS,
                    })}
                    {' · '}
                    {tier ? t(TIER_META[tier].labelKey) : ''}
                </p>
            </div>
            <p className="text-[11px] opacity-70 line-through whitespace-pre-wrap">{learnerResponse}</p>
            <p className="text-xs whitespace-pre-wrap leading-relaxed">{guidance}</p>
        </div>
    );
}

function TutorOutcomeBadge({ state }: { state: TutorState }) {
    const { t } = useTranslation();
    if (state.outcome === 'success') {
        return (
            <span className="flex items-center space-x-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                <Check size={11} />
                <span>
                    {t('dashboard.assignments.editor.task_types.socratic_problem.tutor.badge_solved', {
                        attempt: state.attempts.findIndex((a) => a.correct) + 1,
                    })}
                </span>
            </span>
        );
    }
    if (state.outcome === 'failed') {
        return (
            <span className="flex items-center space-x-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-100 text-rose-800">
                <X size={11} />
                <span>{t('dashboard.assignments.editor.task_types.socratic_problem.tutor.badge_revealed')}</span>
            </span>
        );
    }
    return (
        <span className="flex items-center space-x-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
            <span>
                {t('dashboard.assignments.editor.task_types.socratic_problem.tutor.badge_in_progress', {
                    used: state.attempts.length,
                    max: MAX_TUTOR_ATTEMPTS,
                })}
            </span>
        </span>
    );
}

export default TaskSocraticObject;
