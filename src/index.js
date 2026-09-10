const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { pool, initDB } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// Инициализация БД при запуске
initDB();

// 1. ПРОЕКТЫ


// Получить проект со всеми задачами и связями
app.get('/api/projects/:id', async (req, res) => {
  try {
    const projectId = req.params.id;
    const projectRes = await pool.query('SELECT * FROM projects WHERE id = $1', [projectId]);
    if (projectRes.rows.length === 0) return res.status(404).json({ error: 'Проект не найден' });
    
    const tasksRes = await pool.query('SELECT * FROM tasks WHERE project_id = $1', [projectId]);
    const depsRes = await pool.query(`
      SELECT predecessor_id, successor_id FROM task_dependencies 
      WHERE predecessor_id IN (SELECT id FROM tasks WHERE project_id = $1)
    `, [projectId]);

    res.json({ 
      project: projectRes.rows[0], 
      tasks: tasksRes.rows, 
      dependencies: depsRes.rows 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// СОЗДАТЬ проект 
app.post('/api/projects', async (req, res) => {
  const { name, start_date, end_date } = req.body;
  console.log(`\n📁 СОЗДАНИЕ ПРОЕКТА:`);
  console.log(`   Название: ${name}`);
  console.log(`   Сроки: ${start_date} - ${end_date}`);
  
  try {
    const result = await pool.query(`
      INSERT INTO projects (name, start_date, end_date) 
      VALUES ($1, $2, $3) RETURNING *
    `, [name, start_date, end_date]);
    
    console.log(`   ✅ Проект создан с id=${result.rows[0].id}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(`   ❌ Ошибка:`, err.message);
    res.status(500).json({ error: err.message });
  }
});



// Обновить задачу + КАСКАДНЫЙ СДВИГ
app.put('/api/tasks/:id', async (req, res) => {
  const taskId = req.params.id;
  const { start_date, end_date, name, status, assignee_id, progress } = req.body;

  console.log(`\n========================================`);
  console.log(`📥 ПОЛУЧЕН ЗАПРОС PUT /api/tasks/${taskId}`);
  console.log(`📦 Тело запроса:`, req.body);
  console.log(`========================================\n`);

  try {
    const oldTaskRes = await pool.query('SELECT start_date, end_date FROM tasks WHERE id = $1', [taskId]);
    const oldTask = oldTaskRes.rows[0];

    if (!oldTask) return res.status(404).json({ error: 'Задача не найдена' });

    const newStart = start_date || oldTask.start_date;
    const newEnd = end_date || oldTask.end_date;

    console.log(`🕒 Старые даты: ${oldTask.start_date} - ${oldTask.end_date}`);
    console.log(`🕒 Новые даты: ${newStart} - ${newEnd}`);

    const oldStartObj = new Date(oldTask.start_date);
    const newStartObj = new Date(newStart);
    const deltaDays = Math.round((newStartObj - oldStartObj) / (1000 * 60 * 60 * 24));

    console.log(`📏 Дельта сдвига: ${deltaDays} дней`);

    await pool.query(`
      UPDATE tasks SET start_date = $1, end_date = $2, name = COALESCE($3, name), 
      status = COALESCE($4, status), assignee_id = COALESCE($5, assignee_id), progress = COALESCE($6, progress)
      WHERE id = $7
    `, [newStart, newEnd, name, status, assignee_id, progress, taskId]);

    console.log(`✅ Задача ${taskId} обновлена в БД.`);

    if (deltaDays !== 0) {
      console.log(`🚀 ЗАПУСКАЕМ КАСКАДНЫЙ СДВИГ для задачи ${taskId}...`);
      await cascadeShift(taskId, deltaDays);
      console.log(`🏁 Каскадный сдвиг завершен.`);
    } else {
      console.log(`⏸️ Дельта равна 0, каскад не нужен.`);
    }

    res.json({ success: true, message: 'Задача обновлена, каскад применен' });
  } catch (err) {
    console.error(`❌ ОШИБКА:`, err);
    res.status(500).json({ error: err.message });
  }
});

// Создать задачу
app.post('/api/tasks', async (req, res) => {
  const { project_id, name, start_date, end_date, assignee_id } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO tasks (project_id, name, start_date, end_date, assignee_id) 
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [project_id, name, start_date, end_date, assignee_id]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Создать связь между задачами
app.post('/api/tasks/link', async (req, res) => {
  const { predecessor_id, successor_id } = req.body;
  try {
    await pool.query(`
      INSERT INTO task_dependencies (predecessor_id, successor_id) VALUES ($1, $2)
    `, [predecessor_id, successor_id]);
    res.status(201).json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'Такая связь уже существует' });
  }
});
app.get('/api/seed', async (req, res) => {
  try {
    await pool.query(`INSERT INTO projects (name, start_date, end_date) VALUES ('Проект', '2026-09-15', '2026-10-15')`);
    await pool.query(`INSERT INTO tasks (project_id, name, start_date, end_date) VALUES (1, 'Анализ', '2026-09-15', '2026-09-20'), (1, 'Разработка', '2026-09-21', '2026-10-01'), (1, 'Тестирование', '2026-10-02', '2026-10-10')`);
    await pool.query(`INSERT INTO task_dependencies (predecessor_id, successor_id) VALUES (1, 2), (2, 3)`);
    res.json({ success: true, message: 'База заполнена!' });
  } catch (err) {
    res.json({ message: 'Уже заполнено или ошибка: ' + err.message });
  }
});
// 3. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ

async function cascadeShift(parentId, deltaDays, visited = new Set()) {
  console.log(`  🔍 cascadeShift: ищем детей для родителя ${parentId}`);
  
  if (visited.has(parentId)) {
    console.log(`  ⚠️ Задача ${parentId} уже обработана (защита от цикла)`);
    return;
  }
  visited.add(parentId);

  const childrenRes = await pool.query(`
    SELECT t.id, t.name, t.start_date, t.end_date 
    FROM tasks t
    JOIN task_dependencies td ON t.id = td.successor_id
    WHERE td.predecessor_id = $1
  `, [parentId]);

  console.log(`  📋 Найдено дочерних задач: ${childrenRes.rows.length}`);

  for (const child of childrenRes.rows) {
    console.log(`    ➡️ Обрабатываем задачу ${child.id} "${child.name}"`);
    
    const oldStart = new Date(child.start_date);
    const oldEnd = new Date(child.end_date);
    
    oldStart.setDate(oldStart.getDate() + deltaDays);
    oldEnd.setDate(oldEnd.getDate() + deltaDays);

    const newStartStr = oldStart.toISOString().split('T')[0];
    const newEndStr = oldEnd.toISOString().split('T')[0];
    
    console.log(`       📅 Было: ${child.start_date} -> ${child.end_date}`);
    console.log(`       📅 Стало: ${newStartStr} -> ${newEndStr}`);

    await pool.query(`
      UPDATE tasks SET start_date = $1, end_date = $2 WHERE id = $3
    `, [newStartStr, newEndStr, child.id]);
    
    console.log(`       💾 UPDATE выполнен для задачи ${child.id}`);

    await cascadeShift(child.id, deltaDays, visited);
  }
}


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(` Сервер запущен`);
});