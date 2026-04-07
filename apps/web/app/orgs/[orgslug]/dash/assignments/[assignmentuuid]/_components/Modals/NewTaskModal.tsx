import { useAssignmentsTaskDispatch } from '@components/Contexts/Assignments/AssignmentsTaskContext';
import { useLHSession } from '@components/Contexts/LHSessionContext';
import { getAPIUrl } from '@services/config/config';
import { createAssignmentTask } from '@services/courses/assignments'
import { AArrowUp, BrainCircuit, FileUp, ListTodo } from 'lucide-react'
import React from 'react'
import toast from 'react-hot-toast';
import { mutate } from 'swr';
import { useTranslation } from 'react-i18next';

function NewTaskModal({ closeModal, assignment_uuid }: any) {
  const { t } = useTranslation()
  const session = useLHSession() as any;
  const access_token = session?.data?.tokens?.access_token;
  const reminderShownRef = React.useRef(false);
  const assignmentTaskStateHook = useAssignmentsTaskDispatch() as any

  function showReminderToast() {
    // Check if the reminder has already been shown using sessionStorage
    if (sessionStorage.getItem("TasksReminderShown") !== "true") {
      setTimeout(() => {
        toast(t('dashboard.assignments.editor.toasts.reminder'),
              { icon: '✋', duration: 10000, style: { minWidth: 600 }  });
        // Mark the reminder as shown in sessionStorage
        sessionStorage.setItem("TasksReminderShown", "true");
      }, 3000);
    }
  }

  async function createTask(type: string) {
    const task_object = {
      title: "Untitled Task",
      description: "",
      hint: "",
      reference_file: "",
      assignment_type: type,
      contents: {},
      max_grade_value: 100,
    }
    const res = await createAssignmentTask(task_object, assignment_uuid, access_token)

    if (!res.success) {
      toast.error(
        res?.data?.detail ||
        res?.data?.message ||
        'Unable to create task'
      )
      return
    }

    toast.success(t('dashboard.assignments.editor.toasts.task_created'))
    showReminderToast()
    mutate(`${getAPIUrl()}assignments/${assignment_uuid}/tasks`)
    assignmentTaskStateHook({ type: 'setSelectedAssignmentTaskUUID', payload: res.data.assignment_task_uuid })
    closeModal(false)
  }

  const taskOptions = [
    {
      type: 'SOCRATIC_PROBLEM',
      icon: BrainCircuit,
      title: t('dashboard.assignments.editor.task_types.socratic_problem.title'),
      description: t('dashboard.assignments.editor.task_types.socratic_problem.description'),
    },
    {
      type: 'QUIZ',
      icon: ListTodo,
      title: t('dashboard.assignments.editor.task_types.quiz.title'),
      description: t('dashboard.assignments.editor.task_types.quiz.description'),
    },
    {
      type: 'FILE_SUBMISSION',
      icon: FileUp,
      title: t('dashboard.assignments.editor.task_types.file_submission.title'),
      description: t('dashboard.assignments.editor.task_types.file_submission.description'),
    },
    {
      type: 'FORM',
      icon: AArrowUp,
      title: t('dashboard.assignments.editor.task_types.form.title'),
      description: t('dashboard.assignments.editor.task_types.form.description'),
    },
  ]

  return (
    <div className='mx-auto grid w-full max-w-4xl grid-cols-2 gap-3 px-2 py-2 md:grid-cols-4'>
      {taskOptions.map((taskOption) => {
        const Icon = taskOption.icon

        return (
          <button
            key={taskOption.type}
            type='button'
            onClick={() => createTask(taskOption.type)}
            className='flex min-h-36 flex-col items-center justify-center rounded-2xl border border-gray-200 bg-white px-3 py-4 text-center transition-all ease-linear hover:-translate-y-0.5 hover:border-gray-300 hover:bg-gray-50 hover:shadow-lg'
          >
            <div className='mb-2 rounded-full bg-gray-100/80 p-3 text-gray-500 nice-shadow'>
              <Icon size={24} />
            </div>
            <p className='text-base font-semibold text-gray-700 sm:text-lg'>{taskOption.title}</p>
            <p className='mt-1 max-w-44 text-xs leading-snug text-gray-500 sm:text-sm'>{taskOption.description}</p>
          </button>
        )
      })}
    </div>
  )
}

export default NewTaskModal
