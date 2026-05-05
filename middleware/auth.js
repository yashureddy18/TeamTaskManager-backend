const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Authenticate user middleware
const authenticate = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    
    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token or user not found.'
      });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token.'
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired.'
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Server error during authentication.'
    });
  }
};

// Admin role middleware
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Admin role required.'
    });
  }
  next();
};

// Project member middleware
const requireProjectMember = async (req, res, next) => {
  try {
    const Project = require('../models/Project');
    const projectId = req.params.id || req.body.project;
    
    const project = await Project.findById(projectId).populate('members.user');
    
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found.'
      });
    }

    const isMember = project.owner.toString() === req.user._id.toString() ||
                     project.members.some(member => 
                       member.user._id.toString() === req.user._id.toString()
                     ) ||
                     req.user.role === 'admin';

    if (!isMember) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Project membership required.'
      });
    }

    req.project = project;
    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error during authorization.'
    });
  }
};

// Project owner middleware
const requireProjectOwner = async (req, res, next) => {
  try {
    const Project = require('../models/Project');
    const projectId = req.params.id;
    
    const project = await Project.findById(projectId);
    
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found.'
      });
    }

    const isOwner = project.owner.toString() === req.user._id.toString() ||
                   req.user.role === 'admin';

    if (!isOwner) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Project owner role required.'
      });
    }

    req.project = project;
    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error during authorization.'
    });
  }
};

module.exports = {
  authenticate,
  requireAdmin,
  requireProjectMember,
  requireProjectOwner
};
