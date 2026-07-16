import { Router } from 'express';

export function createProjectRecordingRouter({ projectRecordingService, terminalRecorder }) {
  const router = Router();

  // 获取有录制数据的项目列表
  router.get('/', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 20;
      const projects = projectRecordingService.getProjectsWithRecordings(limit);
      res.json({ success: true, data: projects });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取单个录制片段的事件（必须在 /:projectPath 之前，避免路由冲突）
  router.get('/segment/:segmentId', (req, res) => {
    try {
      const segmentId = parseInt(req.params.segmentId);
      const events = projectRecordingService.getSegmentEvents(segmentId);
      if (!events) {
        return res.status(404).json({ error: '片段不存在' });
      }
      res.json({ success: true, data: events });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取项目录制统计（必须在 /:projectPath 之前，避免路由冲突）
  router.get('/stats', (req, res) => {
    try {
      const stats = projectRecordingService.getStats();
      res.json({ success: true, data: stats });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 手动迁移会话录制到项目（用于测试和补救）
  router.post('/migrate', (req, res) => {
    try {
      const { sessionId, projectPath } = req.body;
      if (!sessionId || !projectPath) {
        return res.status(400).json({ error: '需要 sessionId 和 projectPath' });
      }

      // 获取会话录制时间范围
      const range = terminalRecorder.getTimeRange(sessionId);
      if (!range || !range.startTime) {
        return res.status(404).json({ error: '该会话没有录制数据' });
      }

      // 创建单项目历史记录（使用下划线命名以匹配 ProjectRecordingService）
      const projectHistory = [{
        project_path: projectPath,
        start_time: range.startTime,
        end_time: range.endTime
      }];

      // 执行迁移
      projectRecordingService.migrateSessionRecordings(sessionId, projectHistory, terminalRecorder);

      // 返回迁移结果
      const projectInfo = projectRecordingService.getProjectRecordings(projectPath);
      res.json({
        success: true,
        message: '迁移完成',
        data: {
          sessionId,
          projectPath,
          timeRange: projectInfo.timeRange
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取项目的录制片段列表
  router.get('/:projectPath', (req, res) => {
    try {
      const projectPath = decodeURIComponent(req.params.projectPath);
      const limit = parseInt(req.query.limit) || 50;
      const segments = projectRecordingService.getProjectRecordings(projectPath, limit);
      const timeRange = projectRecordingService.getProjectTimeRange(projectPath);
      res.json({ success: true, data: { segments, timeRange } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取项目的录制事件（用于回放）
  router.get('/:projectPath/events', (req, res) => {
    try {
      const projectPath = decodeURIComponent(req.params.projectPath);
      const startTime = parseInt(req.query.startTime) || 0;
      const endTime = parseInt(req.query.endTime) || Date.now();
      const events = projectRecordingService.getProjectEvents(projectPath, startTime, endTime);
      const timeRange = projectRecordingService.getProjectTimeRange(projectPath);
      res.json({ success: true, data: { events, timeRange } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 删除项目的所有录制
  router.delete('/:projectPath', (req, res) => {
    try {
      const projectPath = decodeURIComponent(req.params.projectPath);
      const deleted = projectRecordingService.deleteProjectRecordings(projectPath);
      res.json({ success: true, deleted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
