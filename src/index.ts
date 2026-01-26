/**
 * opentasks - A library for managing tasks
 */

export interface Task {
  id: string;
  title: string;
  completed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTaskInput {
  title: string;
}

export function createTask(input: CreateTaskInput): Task {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    title: input.title,
    completed: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function completeTask(task: Task): Task {
  return {
    ...task,
    completed: true,
    updatedAt: new Date(),
  };
}

export function updateTaskTitle(task: Task, title: string): Task {
  return {
    ...task,
    title,
    updatedAt: new Date(),
  };
}
