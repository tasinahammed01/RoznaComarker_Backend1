/**
 * notificationRealtime.test.js
 * 
 * Unit tests for SSE notification publishing behavior.
 * Tests connection management and event publishing.
 */

const notificationRealtime = require('../notificationRealtime.service');

describe('SSE Notification Realtime Service', () => {
  describe('Connection Management', () => {
    it('should register a new SSE connection', () => {
      const userId = 'user123';
      const mockResponse = {
        write: jest.fn(),
        on: jest.fn(),
      };

      notificationRealtime.registerConnection(userId, mockResponse);
      
      const connections = notificationRealtime.getConnections(userId);
      expect(connections).toBeDefined();
      expect(connections.length).toBeGreaterThan(0);
    });

    it('should remove connection on client disconnect', () => {
      const userId = 'user123';
      const mockResponse = {
        write: jest.fn(),
        on: jest.fn((event, callback) => {
          if (event === 'close') callback();
        }),
      };

      notificationRealtime.registerConnection(userId, mockResponse);
      
      const connectionsBefore = notificationRealtime.getConnections(userId);
      expect(connectionsBefore.length).toBeGreaterThan(0);
    });

    it('should handle multiple connections per user', () => {
      const userId = 'user123';
      const mockResponse1 = { write: jest.fn(), on: jest.fn() };
      const mockResponse2 = { write: jest.fn(), on: jest.fn() };

      notificationRealtime.registerConnection(userId, mockResponse1);
      notificationRealtime.registerConnection(userId, mockResponse2);
      
      const connections = notificationRealtime.getConnections(userId);
      expect(connections.length).toBe(2);
    });
  });

  describe('Event Publishing', () => {
    it('should publish event to specific user', () => {
      const userId = 'teacher123';
      const mockResponse = {
        write: jest.fn(),
        on: jest.fn(),
      };

      notificationRealtime.registerConnection(userId, mockResponse);
      
      const eventData = {
        type: 'worksheet_submitted',
        worksheetId: 'ws123',
        studentId: 'student123',
        score: 85,
      };

      notificationRealtime.publishNotification(userId, eventData);
      
      expect(mockResponse.write).toHaveBeenCalled();
      const writtenData = mockResponse.write.mock.calls[0][0];
      expect(writtenData).toContain('worksheet_submitted');
    });

    it('should publish event to all connections for a user', () => {
      const userId = 'teacher123';
      const mockResponse1 = { write: jest.fn(), on: jest.fn() };
      const mockResponse2 = { write: jest.fn(), on: jest.fn() };

      notificationRealtime.registerConnection(userId, mockResponse1);
      notificationRealtime.registerConnection(userId, mockResponse2);
      
      const eventData = { type: 'test_event' };
      notificationRealtime.publishNotification(userId, eventData);
      
      expect(mockResponse1.write).toHaveBeenCalled();
      expect(mockResponse2.write).toHaveBeenCalled();
    });

    it('should handle publish to user with no connections gracefully', () => {
      const userId = 'nonexistent_user';
      const eventData = { type: 'test_event' };
      
      expect(() => {
        notificationRealtime.publishNotification(userId, eventData);
      }).not.toThrow();
    });

    it('should format event data as SSE message', () => {
      const userId = 'teacher123';
      const mockResponse = {
        write: jest.fn(),
        on: jest.fn(),
      };

      notificationRealtime.registerConnection(userId, mockResponse);
      
      const eventData = {
        type: 'worksheet_started',
        worksheetId: 'ws123',
        studentId: 'student123',
      };

      notificationRealtime.publishNotification(userId, eventData);
      
      const writtenData = mockResponse.write.mock.calls[0][0];
      expect(writtenData).toContain('data:');
      expect(writtenData).toContain('worksheet_started');
    });
  });

  describe('Worksheet-Specific Events', () => {
    it('should publish worksheet_started event', () => {
      const userId = 'teacher123';
      const mockResponse = { write: jest.fn(), on: jest.fn() };

      notificationRealtime.registerConnection(userId, mockResponse);
      
      const eventData = {
        type: 'worksheet_started',
        worksheetId: 'ws123',
        studentId: 'student123',
        timestamp: new Date().toISOString(),
      };

      notificationRealtime.publishNotification(userId, eventData);
      
      expect(mockResponse.write).toHaveBeenCalled();
      const writtenData = mockResponse.write.mock.calls[0][0];
      expect(writtenData).toContain('worksheet_started');
    });

    it('should publish worksheet_progress event', () => {
      const userId = 'teacher123';
      const mockResponse = { write: jest.fn(), on: jest.fn() };

      notificationRealtime.registerConnection(userId, mockResponse);
      
      const eventData = {
        type: 'worksheet_progress',
        worksheetId: 'ws123',
        studentId: 'student123',
        progressPercentage: 50,
        timestamp: new Date().toISOString(),
      };

      notificationRealtime.publishNotification(userId, eventData);
      
      expect(mockResponse.write).toHaveBeenCalled();
      const writtenData = mockResponse.write.mock.calls[0][0];
      expect(writtenData).toContain('worksheet_progress');
    });

    it('should publish worksheet_submitted event with score', () => {
      const userId = 'teacher123';
      const mockResponse = { write: jest.fn(), on: jest.fn() };

      notificationRealtime.registerConnection(userId, mockResponse);
      
      const eventData = {
        type: 'worksheet_submitted',
        worksheetId: 'ws123',
        worksheetTitle: 'Test Worksheet',
        assignmentId: 'assign123',
        studentId: 'student123',
        score: 85,
        totalPoints: 100,
        percentage: 85,
        status: 'submitted',
        isLate: false,
        submittedAt: new Date().toISOString(),
      };

      notificationRealtime.publishNotification(userId, eventData);
      
      expect(mockResponse.write).toHaveBeenCalled();
      const writtenData = mockResponse.write.mock.calls[0][0];
      expect(writtenData).toContain('worksheet_submitted');
      expect(writtenData).toContain('85'); // score
    });
  });

  describe('Error Handling', () => {
    it('should handle write errors gracefully', () => {
      const userId = 'teacher123';
      const mockResponse = {
        write: jest.fn(() => {
          throw new Error('Write error');
        }),
        on: jest.fn(),
      };

      notificationRealtime.registerConnection(userId, mockResponse);
      
      const eventData = { type: 'test_event' };
      
      expect(() => {
        notificationRealtime.publishNotification(userId, eventData);
      }).not.toThrow();
    });

    it('should handle invalid event data gracefully', () => {
      const userId = 'teacher123';
      const mockResponse = { write: jest.fn(), on: jest.fn() };

      notificationRealtime.registerConnection(userId, mockResponse);
      
      const invalidData = null;
      
      expect(() => {
        notificationRealtime.publishNotification(userId, invalidData);
      }).not.toThrow();
    });
  });
});
