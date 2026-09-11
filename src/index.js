const express = require('express');
const cors = require('cors');
const { pool, initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ======================================================
// ИНИЦИАЛИЗАЦИЯ БАЗЫ
// ======================================================

initDB();

// ======================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ======================================================

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Возвращает проект вместе с задачами и зависимостями.
 */
async function getProjectData(projectId, client = pool) {
  const projectResult = await client.query(
    `
      SELECT *
      FROM projects
      WHERE id = $1
    `,
    [projectId]
  );

  if (projectResult.rows.length === 0) {
    return null;
  }

  const tasksResult = await client.query(
    `
      SELECT *
      FROM tasks
      WHERE project_id = $1
      ORDER BY start_date, id
    `,
    [projectId]
  );

  const dependenciesResult = await client.query(
    `
      SELECT td.*
      FROM task_dependencies td
      JOIN tasks successor
        ON successor.id = td.successor_id
      WHERE successor.project_id = $1
      ORDER BY td.id
    `,
    [projectId]
  );

  const tasks = tasksResult.rows.map((task) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const endDate = new Date(task.end_date);
    endDate.setHours(0, 0, 0, 0);

    if (
      endDate < today &&
      task.status !== 'done'
    ) {
      return {
        ...task,
        status: 'overdue',
      };
    }

    return task;
  });

  return {
    project: projectResult.rows[0],
    tasks,
    dependencies: dependenciesResult.rows,
  };
}

/**
 * Проверяем существование пользователя.
 */
async function userExists(userId, client = pool) {
  if (userId === null || userId === undefined) {
    return true;
  }

  const result = await client.query(
    `
      SELECT id
      FROM users
      WHERE id = $1
    `,
    [userId]
  );

  return result.rows.length > 0;
}

/**
 * Получить всех непосредственных последователей задачи.
 */
async function getSuccessors(taskId, client) {
  const result = await client.query(
    `
      SELECT successor_id
      FROM task_dependencies
      WHERE predecessor_id = $1
    `,
    [taskId]
  );

  return result.rows.map((row) => row.successor_id);
}

/**
 * Каскадный сдвиг всех последующих задач.
 *
 * Если задача сдвинулась на N дней,
 * все её зависимые задачи тоже сдвигаются на N дней.
 */
async function shiftSuccessors(
  taskId,
  deltaDays,
  client,
  visited = new Set()
) {
  if (deltaDays === 0) {
    return;
  }

  if (visited.has(taskId)) {
    return;
  }

  visited.add(taskId);

  const successors = await getSuccessors(
    taskId,
    client
  );

  for (const successorId of successors) {
    const taskResult = await client.query(
      `
        SELECT *
        FROM tasks
        WHERE id = $1
      `,
      [successorId]
    );

    if (taskResult.rows.length === 0) {
      continue;
    }

    const task = taskResult.rows[0];

    const newStart = addDays(
      new Date(task.start_date),
      deltaDays
    );

    const newEnd = addDays(
      new Date(task.end_date),
      deltaDays
    );

    await client.query(
      `
        UPDATE tasks
        SET
          start_date = $1,
          end_date = $2
        WHERE id = $3
      `,
      [
        formatDate(newStart),
        formatDate(newEnd),
        successorId,
      ]
    );

    await shiftSuccessors(
      successorId,
      deltaDays,
      client,
      visited
    );
  }
}

/**
 * Проверяем, создаст ли зависимость цикл.
 *
 * Например:
 *
 * A -> B
 * B -> C
 *
 * нельзя добавить:
 *
 * C -> A
 */
async function createsCycle(
  predecessorId,
  successorId,
  client
) {
  if (Number(predecessorId) === Number(successorId)) {
    return true;
  }

  const visited = new Set();
  const stack = [successorId];

  while (stack.length > 0) {
    const current = stack.pop();

    if (Number(current) === Number(predecessorId)) {
      return true;
    }

    if (visited.has(current)) {
      continue;
    }

    visited.add(current);

    const result = await client.query(
      `
        SELECT successor_id
        FROM task_dependencies
        WHERE predecessor_id = $1
      `,
      [current]
    );

    for (const row of result.rows) {
      stack.push(row.successor_id);
    }
  }

  return false;
}

// ======================================================
// СЛУЖЕБНЫЙ ENDPOINT
// ======================================================

app.get('/', (req, res) => {
  res.json({
    message: 'Gantt backend работает',
  });
});

// ======================================================
// USERS
// ======================================================

/**
 * Получить список ответственных.
 *
 * Frontend использует:
 *
 * GET /api/users
 */
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT id, name
        FROM users
        ORDER BY name
      `
    );

    res.json(result.rows);
  } catch (err) {
    console.error(
      'Ошибка загрузки пользователей:',
      err
    );

    res.status(500).json({
      error: err.message,
    });
  }
});

/**
 * Создать пользователя.
 *
 * Можно использовать для наполнения списка
 * ответственных.
 */
app.post('/api/users', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        error: 'Необходимо указать имя пользователя',
      });
    }

    const result = await pool.query(
      `
        INSERT INTO users (name)
        VALUES ($1)
        RETURNING *
      `,
      [name.trim()]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(
      'Ошибка создания пользователя:',
      err
    );

    res.status(500).json({
      error: err.message,
    });
  }
});

// ======================================================
// PROJECTS
// ======================================================

/**
 * Получить проект вместе с задачами
 * и зависимостями.
 */
app.get(
  '/api/projects/:id',
  async (req, res) => {
    try {
      const projectId = Number(req.params.id);

      if (!Number.isInteger(projectId)) {
        return res.status(400).json({
          error: 'Некорректный ID проекта',
        });
      }

      const data = await getProjectData(projectId);

      if (!data) {
        return res.status(404).json({
          error: 'Проект не найден',
        });
      }

      res.json(data);
    } catch (err) {
      console.error(
        'Ошибка загрузки проекта:',
        err
      );

      res.status(500).json({
        error: err.message,
      });
    }
  }
);

/**
 * Создать проект.
 */
app.post('/api/projects', async (req, res) => {
  try {
    const {
      name,
      start_date,
      end_date,
    } = req.body;

    if (!name || !start_date || !end_date) {
      return res.status(400).json({
        error:
          'Необходимо указать название, дату начала и дату окончания проекта',
      });
    }

    if (
      new Date(end_date) <
      new Date(start_date)
    ) {
      return res.status(400).json({
        error:
          'Дата окончания проекта не может быть раньше даты начала',
      });
    }

    const result = await pool.query(
      `
        INSERT INTO projects (
          name,
          start_date,
          end_date
        )
        VALUES ($1, $2, $3)
        RETURNING *
      `,
      [
        name.trim(),
        start_date,
        end_date,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(
      'Ошибка создания проекта:',
      err
    );

    res.status(500).json({
      error: err.message,
    });
  }
});

// ======================================================
// TASKS
// ======================================================

/**
 * Создать задачу.
 */
app.post('/api/tasks', async (req, res) => {
  try {
    const {
      project_id,
      name,
      start_date,
      end_date,
      assignee_id,
    } = req.body;

    if (
      !project_id ||
      !name ||
      !start_date ||
      !end_date
    ) {
      return res.status(400).json({
        error:
          'Необходимо указать project_id, name, start_date и end_date',
      });
    }

    if (
      new Date(end_date) <
      new Date(start_date)
    ) {
      return res.status(400).json({
        error:
          'Дата окончания задачи не может быть раньше даты начала',
      });
    }

    const projectResult = await pool.query(
      `
        SELECT id
        FROM projects
        WHERE id = $1
      `,
      [project_id]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Проект не найден',
      });
    }

    if (
      assignee_id !== null &&
      assignee_id !== undefined
    ) {
      const exists = await userExists(
        assignee_id
      );

      if (!exists) {
        return res.status(400).json({
          error:
            'Пользователь с таким ID не существует',
        });
      }
    }

    const result = await pool.query(
      `
        INSERT INTO tasks (
          project_id,
          assignee_id,
          name,
          start_date,
          end_date
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `,
      [
        project_id,
        assignee_id ?? null,
        name.trim(),
        start_date,
        end_date,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(
      'Ошибка создания задачи:',
      err
    );

    res.status(500).json({
      error: err.message,
    });
  }
});

/**
 * Редактирование задачи.
 *
 * Поддерживает:
 * - название
 * - даты
 * - статус
 * - ответственного
 * - прогресс
 *
 * При изменении start_date выполняется
 * каскадный сдвиг зависимых задач.
 */
app.put(
  '/api/tasks/:id',
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const taskId = Number(req.params.id);

      if (!Number.isInteger(taskId)) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error: 'Некорректный ID задачи',
        });
      }

      const oldTaskResult =
        await client.query(
          `
            SELECT *
            FROM tasks
            WHERE id = $1
          `,
          [taskId]
        );

      if (
        oldTaskResult.rows.length === 0
      ) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          error: 'Задача не найдена',
        });
      }

      const oldTask =
        oldTaskResult.rows[0];

      const {
        name,
        start_date,
        end_date,
        status,
        assignee_id,
        progress,
      } = req.body;

      const newName =
        name !== undefined
          ? name.trim()
          : oldTask.name;

      const newStartDate =
        start_date !== undefined
          ? start_date
          : oldTask.start_date;

      const newEndDate =
        end_date !== undefined
          ? end_date
          : oldTask.end_date;

      const newStatus =
        status !== undefined
          ? status
          : oldTask.status;

      /*
       * Здесь специально НЕ используется COALESCE.
       *
       * Благодаря этому frontend может отправить:
       *
       * assignee_id: null
       *
       * и реально убрать ответственного.
       */
      const newAssigneeId =
        Object.prototype.hasOwnProperty.call(
          req.body,
          'assignee_id'
        )
          ? assignee_id
          : oldTask.assignee_id;

      const newProgress =
        progress !== undefined
          ? Number(progress)
          : oldTask.progress;

      if (!newName) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error:
            'Название задачи не может быть пустым',
        });
      }

      if (
        new Date(newEndDate) <
        new Date(newStartDate)
      ) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error:
            'Дата окончания задачи не может быть раньше даты начала',
        });
      }

      const allowedStatuses = [
        'planned',
        'todo',
        'in_progress',
        'done',
        'overdue',
      ];

      if (
        !allowedStatuses.includes(
          newStatus
        )
      ) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error: 'Некорректный статус задачи',
        });
      }

      if (
        !Number.isFinite(newProgress) ||
        newProgress < 0 ||
        newProgress > 100
      ) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error:
            'Прогресс должен быть от 0 до 100',
        });
      }

      if (
        newAssigneeId !== null &&
        newAssigneeId !== undefined
      ) {
        const exists = await userExists(
          newAssigneeId,
          client
        );

        if (!exists) {
          await client.query('ROLLBACK');

          return res.status(400).json({
            error:
              'Пользователь с таким ID не существует',
          });
        }
      }

      // ==========================================
      // СЧИТАЕМ СДВИГ НАЧАЛА ЗАДАЧИ
      // ==========================================

      let deltaDays = 0;

      if (start_date !== undefined) {
        const oldStart =
          new Date(oldTask.start_date);

        const newStart =
          new Date(newStartDate);

        deltaDays = Math.round(
          (newStart - oldStart) /
            (1000 * 60 * 60 * 24)
        );
      }

      // ==========================================
      // ОБНОВЛЯЕМ САМУ ЗАДАЧУ
      // ==========================================

      await client.query(
        `
          UPDATE tasks
          SET
            name = $1,
            start_date = $2,
            end_date = $3,
            status = $4,
            assignee_id = $5,
            progress = $6
          WHERE id = $7
        `,
        [
          newName,
          newStartDate,
          newEndDate,
          newStatus,
          newAssigneeId ?? null,
          newProgress,
          taskId,
        ]
      );

      // ==========================================
      // КАСКАДНЫЙ СДВИГ
      // ==========================================

      if (deltaDays !== 0) {
        await shiftSuccessors(
          taskId,
          deltaDays,
          client
        );
      }

      await client.query('COMMIT');

      const data = await getProjectData(
        oldTask.project_id
      );

      res.json({
        success: true,
        message: 'Задача обновлена',
        ...data,
      });
    } catch (err) {
      await client.query('ROLLBACK');

      console.error(
        'Ошибка обновления задачи:',
        err
      );

      res.status(500).json({
        error: err.message,
      });
    } finally {
      client.release();
    }
  }
);

// ======================================================
// DELETE TASK
// ======================================================

/**
 * Удалить задачу.
 *
 * Именно этот endpoint теперь использует
 * кнопка "Удалить" во frontend.
 */
app.delete(
  '/api/tasks/:id',
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const taskId = Number(req.params.id);

      if (!Number.isInteger(taskId)) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error: 'Некорректный ID задачи',
        });
      }

      const taskResult =
        await client.query(
          `
            SELECT *
            FROM tasks
            WHERE id = $1
          `,
          [taskId]
        );

      if (
        taskResult.rows.length === 0
      ) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          error: 'Задача не найдена',
        });
      }

      const task =
        taskResult.rows[0];

      /*
       * task_dependencies удалятся автоматически,
       * потому что в db.js FK созданы с:
       *
       * ON DELETE CASCADE
       */
      await client.query(
        `
          DELETE FROM tasks
          WHERE id = $1
        `,
        [taskId]
      );

      await client.query('COMMIT');

      const data = await getProjectData(
        task.project_id
      );

      res.json({
        success: true,
        message: 'Задача удалена',
        ...data,
      });
    } catch (err) {
      await client.query('ROLLBACK');

      console.error(
        'Ошибка удаления задачи:',
        err
      );

      res.status(500).json({
        error: err.message,
      });
    } finally {
      client.release();
    }
  }
);

// ======================================================
// DEPENDENCIES
// ======================================================

/**
 * Создать зависимость:
 *
 * predecessor -> successor
 */
app.post(
  '/api/tasks/link',
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const {
        predecessor_id,
        successor_id,
      } = req.body;

      if (
        !predecessor_id ||
        !successor_id
      ) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error:
            'Необходимо указать predecessor_id и successor_id',
        });
      }

      if (
        Number(predecessor_id) ===
        Number(successor_id)
      ) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error:
            'Задача не может зависеть сама от себя',
        });
      }

      const tasksResult =
        await client.query(
          `
            SELECT id, project_id
            FROM tasks
            WHERE id = ANY($1::int[])
          `,
          [
            [
              Number(predecessor_id),
              Number(successor_id),
            ],
          ]
        );

      if (
        tasksResult.rows.length !== 2
      ) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          error:
            'Одна из задач не найдена',
        });
      }

      const projects = new Set(
        tasksResult.rows.map(
          (task) => task.project_id
        )
      );

      if (projects.size !== 1) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error:
            'Нельзя связывать задачи из разных проектов',
        });
      }

      const cycle = await createsCycle(
        predecessor_id,
        successor_id,
        client
      );

      if (cycle) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error:
            'Невозможно создать зависимость: возникнет цикл',
        });
      }

      const result = await client.query(
        `
          INSERT INTO task_dependencies (
            predecessor_id,
            successor_id
          )
          VALUES ($1, $2)
          ON CONFLICT (
            predecessor_id,
            successor_id
          )
          DO NOTHING
          RETURNING *
        `,
        [
          predecessor_id,
          successor_id,
        ]
      );

      await client.query('COMMIT');

      res.status(201).json({
        success: true,
        dependency:
          result.rows[0] || null,
      });
    } catch (err) {
      await client.query('ROLLBACK');

      console.error(
        'Ошибка создания зависимости:',
        err
      );

      res.status(500).json({
        error: err.message,
      });
    } finally {
      client.release();
    }
  }
);

// ======================================================
// SEED
// ======================================================

/**
 * Тестовые данные.
 *
 * GET /api/seed
 */
app.get('/api/seed', async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ------------------------------------------
    // Пользователи
    // ------------------------------------------

    const seedUsers = [
      'Анна',
      'Иван',
      'Мария',
    ];

    for (const name of seedUsers) {
      const existing =
        await client.query(
          `
            SELECT id
            FROM users
            WHERE name = $1
            LIMIT 1
          `,
          [name]
        );

      if (
        existing.rows.length === 0
      ) {
        await client.query(
          `
            INSERT INTO users (name)
            VALUES ($1)
          `,
          [name]
        );
      }
    }

    const usersResult =
      await client.query(
        `
          SELECT id, name
          FROM users
          ORDER BY id
        `
      );

    // ------------------------------------------
    // Проект
    // ------------------------------------------

    let projectResult =
      await client.query(
        `
          SELECT *
          FROM projects
          WHERE name = 'Тестовый проект'
          LIMIT 1
        `
      );

    let project;

    if (
      projectResult.rows.length === 0
    ) {
      const createdProject =
        await client.query(
          `
            INSERT INTO projects (
              name,
              start_date,
              end_date
            )
            VALUES (
              'Тестовый проект',
              CURRENT_DATE,
              CURRENT_DATE + INTERVAL '30 days'
            )
            RETURNING *
          `
        );

      project =
        createdProject.rows[0];
    } else {
      project =
        projectResult.rows[0];
    }

    // ------------------------------------------
    // Задачи
    // ------------------------------------------

    const existingTasks =
      await client.query(
        `
          SELECT *
          FROM tasks
          WHERE project_id = $1
        `,
        [project.id]
      );

    if (
      existingTasks.rows.length === 0
    ) {
      const anna =
        usersResult.rows[0]?.id ?? null;

      const ivan =
        usersResult.rows[1]?.id ??
        anna;

      const maria =
        usersResult.rows[2]?.id ??
        anna;

      const analysis =
        await client.query(
          `
            INSERT INTO tasks (
              project_id,
              assignee_id,
              name,
              start_date,
              end_date,
              status,
              progress
            )
            VALUES (
              $1,
              $2,
              'Анализ',
              CURRENT_DATE,
              CURRENT_DATE + INTERVAL '4 days',
              'done',
              100
            )
            RETURNING *
          `,
          [project.id, anna]
        );

      const development =
        await client.query(
          `
            INSERT INTO tasks (
              project_id,
              assignee_id,
              name,
              start_date,
              end_date,
              status,
              progress
            )
            VALUES (
              $1,
              $2,
              'Разработка',
              CURRENT_DATE + INTERVAL '5 days',
              CURRENT_DATE + INTERVAL '14 days',
              'in_progress',
              50
            )
            RETURNING *
          `,
          [project.id, ivan]
        );

      const testing =
        await client.query(
          `
            INSERT INTO tasks (
              project_id,
              assignee_id,
              name,
              start_date,
              end_date,
              status,
              progress
            )
            VALUES (
              $1,
              $2,
              'Тестирование',
              CURRENT_DATE + INTERVAL '15 days',
              CURRENT_DATE + INTERVAL '20 days',
              'planned',
              0
            )
            RETURNING *
          `,
          [project.id, maria]
        );

      await client.query(
        `
          INSERT INTO task_dependencies (
            predecessor_id,
            successor_id
          )
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `,
        [
          analysis.rows[0].id,
          development.rows[0].id,
        ]
      );

      await client.query(
        `
          INSERT INTO task_dependencies (
            predecessor_id,
            successor_id
          )
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `,
        [
          development.rows[0].id,
          testing.rows[0].id,
        ]
      );
    }

    await client.query('COMMIT');

    const data = await getProjectData(
      project.id
    );

    res.json({
      success: true,
      message:
        'Тестовые данные готовы',
      users: usersResult.rows,
      ...data,
    });
  } catch (err) {
    await client.query('ROLLBACK');

    console.error(
      'Ошибка seed:',
      err
    );

    res.status(500).json({
      error: err.message,
    });
  } finally {
    client.release();
  }
});

// ======================================================
// 404
// ======================================================

app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint не найден',
  });
});

// ======================================================
// ЗАПУСК
// ======================================================
// AI-анализ проекта
app.get('/api/ai/analyze', async (req, res) => {
  try {
    // Получаем projectId из query параметров (?projectId=1)
    const projectId = req.query.projectId || req.query.id || 1;
    
    // Получаем все задачи проекта
    const tasksRes = await pool.query(
      'SELECT * FROM tasks WHERE project_id = $1', 
      [projectId]
    );
    const tasks = tasksRes.rows;
    
    // Получаем проект
    const projectRes = await pool.query(
      'SELECT * FROM projects WHERE id = $1', 
      [projectId]
    );
    const project = projectRes.rows[0];
    
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }
    
    // Анализируем данные
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    
    // Считаем статистику
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(t => t.status === 'done').length;
    const overdueTasks = tasks.filter(t => {
      const endDate = new Date(t.end_date).toISOString().split('T')[0];
      return endDate < todayStr && t.status !== 'done';
    }).length;
    const inProgressTasks = tasks.filter(t => t.status === 'in_progress').length;
    
    // Находим критические задачи (те, что влияют на срок проекта)
    const criticalTasks = tasks.filter(t => {
      const endDate = new Date(t.end_date);
      const projectEnd = new Date(project.end_date);
      return endDate >= projectEnd && t.status !== 'done';
    });
    
    // Определяем основные риски
    const risks = [];
    
    if (overdueTasks > 0) {
      risks.push({
        type: 'overdue',
        severity: 'high',
        message: `Просрочено задач: ${overdueTasks}`,
        description: 'Некоторые задачи уже просрочены, что может повлиять на общий срок проекта'
      });
    }
    
    if (criticalTasks.length > 0) {
      risks.push({
        type: 'critical_path',
        severity: 'medium',
        message: `Критических задач: ${criticalTasks.length}`,
        description: 'Эти задачи напрямую влияют на дедлайн проекта'
      });
    }
    
    const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    
    if (progressPercent < 50 && new Date(project.end_date) <= new Date()) {
      risks.push({
        type: 'deadline_risk',
        severity: 'high',
        message: 'Высокий риск срыва дедлайна',
        description: `Выполнено только ${progressPercent}% задач до дедлайна`
      });
    }
    
    // Рекомендации
    const recommendations = [];
    
    if (overdueTasks > 0) {
      recommendations.push('Срочно займитесь просроченными задачами');
    }
    
    if (inProgressTasks > 3) {
      recommendations.push('Слишком много задач в работе одновременно. Сфокусируйтесь на завершении.');
    }
    
    if (progressPercent < 30) {
      recommendations.push('Проект на ранней стадии. Убедитесь, что все ресурсы распределены.');
    }
    
    // Формируем ответ для AI
    const analysis = {
      summary: {
        totalTasks,
        completedTasks,
        inProgressTasks,
        overdueTasks,
        progressPercent,
        projectEndDate: project.end_date,
        daysUntilDeadline: Math.ceil((new Date(project.end_date) - today) / (1000 * 60 * 60 * 24))
      },
      risks,
      recommendations,
      criticalTasks: criticalTasks.map(t => ({
        id: t.id,
        name: t.name,
        endDate: t.end_date,
        status: t.status
      })),
      // Готовые ответы на вопросы
      answers: {
        risks: risks.length > 0 
          ? risks.map(r => r.message).join('. ') 
          : 'Пока основных рисков не выявлено. Проект идет по плану.',
        
        priorities: recommendations.length > 0
          ? recommendations.join('. ')
          : 'Продолжайте работу в текущем режиме.',
        
        criticalImpact: criticalTasks.length > 0
          ? `На срок проекта сильнее всего влияют: ${criticalTasks.map(t => t.name).join(', ')}`
          : 'Все задачи выполняются в срок, критических задержек нет.'
      }
    };
    
    res.json(analysis);
  } catch (err) {
    console.error('Ошибка анализа проекта:', err);
    res.status(500).json({ error: 'Ошибка при анализе проекта: ' + err.message });
  }
});

// POST-эндпоинт для AI-вопросов (если фронт отправляет вопросы)
app.post('/api/ai/ask', async (req, res) => {
  try {
    const { question, projectId } = req.body;
    const id = projectId || req.query.projectId || 1;
    
    // Получаем анализ
    const analysisRes = await fetch(`http://localhost:${process.env.PORT || 3001}/api/projects/${projectId}/analyze`);
    const analysis = await analysisRes.json();
    
    // Простые ответы на основе анализа
    let answer = '';
    
    if (question.includes('риск')) {
      answer = analysis.answers.risks;
    } else if (question.includes('приоритет') || question.includes('делать')) {
      answer = analysis.answers.priorities;
    } else if (question.includes('влияют') || question.includes('срок')) {
      answer = analysis.answers.criticalImpact;
    } else {
      answer = `На основе анализа проекта: ${analysis.answers.priorities}`;
    }
    
    res.json({
      question,
      answer,
      analysis
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка: ' + err.message });
  }
});
app.listen(PORT, () => {
  console.log(
    `🚀 Server started on port ${PORT}`
  );
});