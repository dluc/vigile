import type { Operation } from "../operation.js";
import { addLink } from "./add-link.js";
import { createProject } from "./create-project.js";
import { createTask } from "./create-task.js";
import { createUser } from "./create-user.js";
import { deleteItem } from "./delete.js";
import { getGuide } from "./get-guide.js";
import { get } from "./get.js";
import { listLinkTypes } from "./list-link-types.js";
import { listNextTasks } from "./list-next-tasks.js";
import { listProjects } from "./list-projects.js";
import { listTasks } from "./list-tasks.js";
import { listUsers } from "./list-users.js";
import { overrideTimestamp } from "./override-timestamp.js";
import { removeLink } from "./remove-link.js";
import { resetUserKey } from "./reset-user-key.js";
import { restore } from "./restore.js";
import { setProjectStatus } from "./set-project-status.js";
import { setTaskStatus } from "./set-task-status.js";
import { updateTask } from "./update-task.js";

/** Every operation the product offers. MCP, the HTTP API and the CLI are all generated from this list. */
export const OPERATIONS: readonly Operation[] = [
  createProject,
  setProjectStatus,
  listProjects,
  createTask,
  updateTask,
  setTaskStatus,
  listTasks,
  listNextTasks,
  get,
  deleteItem,
  restore,
  overrideTimestamp,
  addLink,
  removeLink,
  listLinkTypes,
  createUser,
  listUsers,
  resetUserKey,
  getGuide,
];

export const findOperation = (name: string): Operation | undefined => OPERATIONS.find((o) => o.name === name);
