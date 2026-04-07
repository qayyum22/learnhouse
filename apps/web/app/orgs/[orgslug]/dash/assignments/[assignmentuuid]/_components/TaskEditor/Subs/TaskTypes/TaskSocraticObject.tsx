import { useAssignments } from '@components/Contexts/Assignments/AssignmentContext';
import { useAssignmentsTask, useAssignmentsTaskDispatch } from '@components/Contexts/Assignments/AssignmentsTaskContext';
import { useLHSession } from '@components/Contexts/LHSessionContext';
import AssignmentBoxUI from '@components/Objects/Activities/Assignment/AssignmentBoxUI';
import { getAssignmentTask, getAssignmentTaskSubmissionsMe, getAssignmentTaskSubmissionsUser, handleAssignmentTaskSubmission, updateAssignmentTask } from '@services/courses/assignments';
import { ArrowRight, Check, ChevronDown, ChevronUp, Eye, HelpCircle, Info, Lightbulb, Minus, PlusCircle, Target } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from 'react-i18next';

type SocraticStep = {
    stepUUID: string;
    guidingQuestion: string;
    expectedInsight: string;
    hint: string;
};

type SocraticSchema = {
    problemStatement: string;
    learningObjective: string;
    steps: SocraticStep[];
};

type SocraticSubmission = {
    stepUUID: string;
    response: string;
    hintUsed?: boolean;
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
    return { stepUUID: 'step_' + uuidv4(), guidingQuestion: '', expectedInsight: '', hint: '' };
}

function emptyProblem(): SocraticSchema {
    return { problemStatement: '', learningObjective: '', steps: [emptyStep()] };
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

    const updateStepField = (sIndex: number, field: 'guidingQuestion' | 'expectedInsight' | 'hint', value: string) => {
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

    const canAdvanceFrom = (sIndex: number) => {
        const step = problem.steps[sIndex];
        if (!step) return false;
        return getResponseForStep(step.stepUUID).trim().length > 0;
    };

    const goToNextStep = () => {
        if (!canAdvanceFrom(activeStepIndex)) {
            toast.error(t('dashboard.assignments.editor.task_types.socratic_problem.errors.answer_first'));
            return;
        }
        if (activeStepIndex < problem.steps.length - 1) {
            setActiveStepIndex(activeStepIndex + 1);
        }
    };

    async function getAssignmentTaskUI() {
        if (assignmentTaskUUID) {
            const res = await getAssignmentTask(assignmentTaskUUID, access_token);
            if (res.success) {
                setAssignmentTaskOutsideProvider(res.data);
                if (res.data.contents?.problem) {
                    setProblem(res.data.contents.problem);
                }
                return res.data.contents?.problem as SocraticSchema | undefined;
            }
        }
        return undefined;
    }

    async function getAssignmentTaskSubmissionFromUserUI(loadedProblem?: SocraticSchema) {
        if (assignmentTaskUUID) {
            const res = await getAssignmentTaskSubmissionsMe(assignmentTaskUUID, assignment.assignment_object.assignment_uuid, access_token);
            if (res.success) {
                const loaded = {
                    ...res.data.task_submission,
                    assignment_task_submission_uuid: res.data.assignment_task_submission_uuid,
                };
                setUserSubmission(loaded);
                setInitialUserSubmission(loaded);
                // Resume at the first step (in authored order) that does not yet have a response.
                const steps = (loadedProblem ?? problem).steps || [];
                const responses: SocraticSubmission[] = res.data.task_submission?.responses || [];
                const firstUnfinished = steps.findIndex(
                    (s) => !responses.find((r) => r.stepUUID === s.stepUUID && r.response?.trim())
                );
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
                const loaded = {
                    ...res.data.task_submission,
                    assignment_task_submission_uuid: res.data.assignment_task_submission_uuid,
                };
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
                setProblem(assignmentTaskState.assignmentTask.contents.problem);
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
        const answeredSteps = problem.steps.filter((s) => getResponseForStep(s.stepUUID).trim()).length;
        const progressPct = totalSteps > 0 ? Math.round((answeredSteps / totalSteps) * 100) : 0;
        const isLastStep = activeStepIndex >= totalSteps - 1;
        const currentStep = problem.steps[activeStepIndex];

        return (
            <AssignmentBoxUI
                submitFC={submitFC}
                view={view}
                maxPoints={assignmentTaskOutsideProvider?.max_grade_value}
                showSavingDisclaimer={showSavingDisclaimer}
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

                            {/* Navigation */}
                            <div className="flex justify-between items-center pt-1">
                                <div
                                    onClick={() => activeStepIndex > 0 && setActiveStepIndex(activeStepIndex - 1)}
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
                                if (!resp.trim() || sIndex === activeStepIndex) return null;
                                return (
                                    <div
                                        key={step.stepUUID}
                                        onClick={() => setActiveStepIndex(sIndex)}
                                        className="flex flex-col p-2 bg-slate-50 rounded-md text-xs cursor-pointer hover:bg-slate-100"
                                    >
                                        <p className="font-semibold text-slate-700">{sIndex + 1}. {step.guidingQuestion}</p>
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
                    return (
                        <div key={step.stepUUID} className="flex flex-col space-y-1.5 p-3 bg-white rounded-md nice-shadow">
                            <div className="flex items-center justify-between">
                                <p className="text-xs font-bold text-indigo-700 uppercase tracking-wide">
                                    {t('dashboard.assignments.editor.task_types.socratic_problem.step_label', { number: sIndex + 1 })}
                                </p>
                                {step.hint && (
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
                                )}
                            </div>
                            <p className="text-sm font-semibold text-slate-800">{step.guidingQuestion}</p>
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

export default TaskSocraticObject;
