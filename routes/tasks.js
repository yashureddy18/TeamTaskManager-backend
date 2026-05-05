const express = require('express');
const { body, validationResult } = require('express-validator');
const Task = require('../models/Task');
const Project = require('../models/Project');
const { authenticate, requireProjectMember } = require('../middleware/auth');

const router = express.Router();

// @route   GET /api/tasks
// @desc    Get all tasks for the authenticated user
// @access  Private
router.get('/', authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const status = req.query.status;
    const priority = req.query.priority;
    const project = req.query.project;
    const assignedTo = req.query.assignedTo;
    const search = req.query.search;
    const overdue = req.query.overdue;

    // Get user's projects
    const userProjects = await Project.find({
      $or: [
        { owner: req.user._id },
        { 'members.user': req.user._id }
      ]
    }).select('_id');

    const projectIds = userProjects.map(p => p._id);

    let query = {
      project: { $in: projectIds }
    };

    if (status) {
      query.status = status;
    }

    if (priority) {
      query.priority = priority;
    }

    if (project) {
      query.project = project;
    }

    if (assignedTo) {
      query.assignedTo = assignedTo;
    }

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    if (overdue === 'true') {
      query.dueDate = { $lt: new Date() };
      query.status = { $ne: 'completed' };
    }

    const tasks = await Task.find(query)
      .populate('project', 'name status')
      .populate('assignedTo', 'name email avatar')
      .populate('createdBy', 'name email avatar')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Task.countDocuments(query);

    res.json({
      success: true,
      data: {
        tasks,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('Get tasks error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching tasks'
    });
  }
});

// @route   POST /api/tasks
// @desc    Create a new task
// @access  Private (project members only)
router.post('/', [
  authenticate,
  body('title')
    .trim()
    .isLength({ min: 2, max: 200 })
    .withMessage('Task title must be between 2 and 200 characters'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Description cannot exceed 1000 characters'),
  body('project')
    .isMongoId()
    .withMessage('Invalid project ID'),
  body('assignedTo')
    .optional({ checkFalsy: true })
    .isMongoId()
    .withMessage('Invalid assignee ID'),
  body('priority')
    .optional()
    .isIn(['low', 'medium', 'high', 'urgent'])
    .withMessage('Invalid priority level'),
  body('type')
    .optional()
    .isIn(['feature', 'bug', 'improvement', 'documentation', 'testing'])
    .withMessage('Invalid task type'),
  body('estimatedHours')
    .optional({ checkFalsy: true })
    .isFloat({ min: 0, max: 1000 })
    .withMessage('Estimated hours must be between 0 and 1000'),
  body('dueDate')
    .optional({ checkFalsy: true })
    .isISO8601()
    .withMessage('Invalid due date format')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation errors',
        errors: errors.array()
      });
    }

    const {
      title,
      description,
      project,
      assignedTo,
      priority = 'medium',
      type = 'feature',
      estimatedHours,
      dueDate,
      tags
    } = req.body;

    // Check if user is a member of the project
    const projectDoc = await Project.findById(project);
    if (!projectDoc) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    const isMember = projectDoc.owner.toString() === req.user._id.toString() ||
                     projectDoc.members.some(member => 
                       member.user.toString() === req.user._id.toString()
                     );

    if (!isMember) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Project membership required.'
      });
    }

    // Validate assignedTo user if provided
    if (assignedTo) {
      const User = require('../models/User');
      const assignee = await User.findById(assignedTo);
      if (!assignee) {
        return res.status(400).json({
          success: false,
          message: 'Assigned user not found'
        });
      }
    }

    const task = new Task({
      title,
      description,
      project,
      assignedTo,
      createdBy: req.user._id,
      priority,
      type,
      estimatedHours,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      tags: tags || []
    });

    await task.save();

    const populatedTask = await Task.findById(task._id)
      .populate('project', 'name status')
      .populate('assignedTo', 'name email avatar')
      .populate('createdBy', 'name email avatar');

    res.status(201).json({
      success: true,
      message: 'Task created successfully',
      data: { task: populatedTask }
    });
  } catch (error) {
    console.error('Create task error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while creating task'
    });
  }
});

// @route   GET /api/tasks/:id
// @desc    Get task by ID
// @access  Private (project members only)
router.get('/:id', authenticate, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id)
      .populate('project', 'name status members owner')
      .populate('assignedTo', 'name email avatar')
      .populate('createdBy', 'name email avatar')
      .populate('comments.user', 'name email avatar')
      .populate('dependencies.task', 'title status');

    if (!task) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }

    // Check if user is a member of the project
    const isMember = task.project.owner.toString() === req.user._id.toString() ||
                     task.project.members.some(member => 
                       member.user.toString() === req.user._id.toString()
                     ) ||
                     req.user.role === 'admin';

    if (!isMember) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Project membership required.'
      });
    }

    res.json({
      success: true,
      data: { task }
    });
  } catch (error) {
    console.error('Get task error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching task'
    });
  }
});

// @route   PUT /api/tasks/:id
// @desc    Update task
// @access  Private (project members only)
router.put('/:id', [
  authenticate,
  body('title')
    .optional()
    .trim()
    .isLength({ min: 2, max: 200 })
    .withMessage('Task title must be between 2 and 200 characters'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Description cannot exceed 1000 characters'),
  body('status')
    .optional()
    .isIn(['todo', 'in-progress', 'review', 'completed', 'cancelled'])
    .withMessage('Invalid status'),
  body('priority')
    .optional()
    .isIn(['low', 'medium', 'high', 'urgent'])
    .withMessage('Invalid priority level'),
  body('type')
    .optional()
    .isIn(['feature', 'bug', 'improvement', 'documentation', 'testing'])
    .withMessage('Invalid task type'),
  body('estimatedHours')
    .optional({ checkFalsy: true })
    .isFloat({ min: 0, max: 1000 })
    .withMessage('Estimated hours must be between 0 and 1000'),
  body('actualHours')
    .optional({ checkFalsy: true })
    .isFloat({ min: 0, max: 1000 })
    .withMessage('Actual hours must be between 0 and 1000'),
  body('dueDate')
    .optional({ checkFalsy: true })
    .isISO8601()
    .withMessage('Invalid due date format')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation errors',
        errors: errors.array()
      });
    }

    const task = await Task.findById(req.params.id).populate('project');
    
    if (!task) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }

    // Check if user is a member of the project
    const isMember = task.project.owner.toString() === req.user._id.toString() ||
                     task.project.members.some(member => 
                       member.user.toString() === req.user._id.toString()
                     ) ||
                     req.user.role === 'admin';

    if (!isMember) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Project membership required.'
      });
    }

    const {
      title,
      description,
      status,
      priority,
      type,
      estimatedHours,
      actualHours,
      dueDate,
      assignedTo,
      tags
    } = req.body;

    const updateData = {};

    if (title) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (status) updateData.status = status;
    if (priority) updateData.priority = priority;
    if (type) updateData.type = type;
    if (estimatedHours !== undefined) updateData.estimatedHours = estimatedHours;
    if (actualHours !== undefined) updateData.actualHours = actualHours;
    if (dueDate) updateData.dueDate = new Date(dueDate);
    if (assignedTo) updateData.assignedTo = assignedTo;
    if (tags) updateData.tags = tags;

    const updatedTask = await Task.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    )
      .populate('project', 'name status')
      .populate('assignedTo', 'name email avatar')
      .populate('createdBy', 'name email avatar')
      .populate('comments.user', 'name email avatar');

    res.json({
      success: true,
      message: 'Task updated successfully',
      data: { task: updatedTask }
    });
  } catch (error) {
    console.error('Update task error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating task'
    });
  }
});

// @route   DELETE /api/tasks/:id
// @desc    Delete task
// @access  Private (project owner or task creator)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id).populate('project');
    
    if (!task) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }

    // Check if user is project owner, task creator, or admin
    const canDelete = task.project.owner.toString() === req.user._id.toString() ||
                     task.createdBy.toString() === req.user._id.toString() ||
                     req.user.role === 'admin';

    if (!canDelete) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only project owner, task creator, or admin can delete tasks.'
      });
    }

    await Task.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Task deleted successfully'
    });
  } catch (error) {
    console.error('Delete task error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while deleting task'
    });
  }
});

// @route   POST /api/tasks/:id/comments
// @desc    Add comment to task
// @access  Private (project members only)
router.post('/:id/comments', [
  authenticate,
  body('text')
    .trim()
    .isLength({ min: 1, max: 500 })
    .withMessage('Comment must be between 1 and 500 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation errors',
        errors: errors.array()
      });
    }

    const task = await Task.findById(req.params.id).populate('project');
    
    if (!task) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }

    // Check if user is a member of the project
    const isMember = task.project.owner.toString() === req.user._id.toString() ||
                     task.project.members.some(member => 
                       member.user.toString() === req.user._id.toString()
                     );

    if (!isMember) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Project membership required.'
      });
    }

    const { text } = req.body;

    task.comments.push({
      user: req.user._id,
      text,
      createdAt: new Date()
    });

    await task.save();

    const updatedTask = await Task.findById(req.params.id)
      .populate('project', 'name status')
      .populate('assignedTo', 'name email avatar')
      .populate('createdBy', 'name email avatar')
      .populate('comments.user', 'name email avatar');

    res.json({
      success: true,
      message: 'Comment added successfully',
      data: { task: updatedTask }
    });
  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while adding comment'
    });
  }
});

// @route   GET /api/tasks/dashboard/stats
// @desc    Get dashboard statistics
// @access  Private
router.get('/dashboard/stats', authenticate, async (req, res) => {
  try {
    // Get user's projects
    const userProjects = await Project.find({
      $or: [
        { owner: req.user._id },
        { 'members.user': req.user._id }
      ]
    }).select('_id');

    const projectIds = userProjects.map(p => p._id);

    // Get task statistics
    const totalTasks = await Task.countDocuments({
      project: { $in: projectIds }
    });

    const todoTasks = await Task.countDocuments({
      project: { $in: projectIds },
      status: 'todo'
    });

    const inProgressTasks = await Task.countDocuments({
      project: { $in: projectIds },
      status: 'in-progress'
    });

    const completedTasks = await Task.countDocuments({
      project: { $in: projectIds },
      status: 'completed'
    });

    const overdueTasks = await Task.countDocuments({
      project: { $in: projectIds },
      dueDate: { $lt: new Date() },
      status: { $ne: 'completed' }
    });

    const myTasks = await Task.countDocuments({
      project: { $in: projectIds },
      assignedTo: req.user._id
    });

    const highPriorityTasks = await Task.countDocuments({
      project: { $in: projectIds },
      priority: { $in: ['high', 'urgent'] },
      status: { $ne: 'completed' }
    });

    res.json({
      success: true,
      data: {
        stats: {
          totalTasks,
          todoTasks,
          inProgressTasks,
          completedTasks,
          overdueTasks,
          myTasks,
          highPriorityTasks,
          completionRate: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0
        }
      }
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching dashboard stats'
    });
  }
});

module.exports = router;
