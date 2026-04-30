require('dotenv').config();
const fs = require('fs');
const http = require('http');
const https = require('https');
const socketIo = require('socket.io');
const { PrismaClient } = require('@prisma/client');

// Verificar se as variáveis de ambiente estão carregadas
console.log('🔧 Variáveis de ambiente carregadas:');
console.log('  DATABASE_URL:', process.env.DATABASE_URL ? '✅ Definida' : '❌ Não definida');
console.log('  NEXTAUTH_SECRET:', process.env.NEXTAUTH_SECRET ? '✅ Definida' : '❌ Não definida');
console.log('  NEXTAUTH_URL:', process.env.NEXTAUTH_URL ? '✅ Definida' : '❌ Não definida');

const PORT = process.env.SOCKET_PORT || 4000;
const NODE_ENV = process.env.NODE_ENV || 'development';

/** Mesma chave que `DIRECT_MESSAGES_POLICY_KEY` em src/lib/system-config.ts */
const DIRECT_MESSAGES_POLICY_KEY = 'direct_messages_policy';

async function getDirectMessagesPolicy() {
  try {
    const row = await prisma.systemConfig.findUnique({
      where: { key: DIRECT_MESSAGES_POLICY_KEY },
    });
    const v = (row?.value || '').trim().toLowerCase();
    if (v === 'all') return 'all';
  } catch (e) {
    console.error('[direct_messages_policy]', e);
  }
  return 'premium_only';
}

/** Conexões WebSocket que ainda não emitiram authenticate (visitantes). */
const anonymousSockets = new Set();

const SOCKET_PRESENCE_SECRET = process.env.SOCKET_PRESENCE_SECRET || '';

function serializeConnectedUsers() {
  return connectedUsers.map((user) => ({
    id: user.userId,
    username: user.username,
    image: user.image,
    city: user.city,
    socketId: user.socketId,
    followersCount: user.followers?.length || 0,
    connectedAt: user.connectedAt?.toISOString?.() ?? null,
  }));
}

function handlePresenceHttp(req, res) {
  const rawUrl = req.url || '/';
  const pathOnly = rawUrl.split('?')[0];
  if (pathOnly !== '/presence' || req.method !== 'GET') {
    return false;
  }

  // Aceita Authorization: Bearer <secret> ou ?token= (útil para diagnóstico)
  let token = '';
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) token = auth.slice(7).trim();
  if (!token) {
    try {
      const qs = rawUrl.includes('?') ? rawUrl.split('?')[1] : '';
      token = new URLSearchParams(qs).get('token') || '';
    } catch (_) {}
  }

  if (!SOCKET_PRESENCE_SECRET || token !== SOCKET_PRESENCE_SECRET) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return true;
  }

  const payload = JSON.stringify({
    registeredCount: connectedUsers.length,
    guestCount: anonymousSockets.size,
    users: serializeConnectedUsers(),
  });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
  return true;
}

let server = http.createServer((req, res) => {
  if (handlePresenceHttp(req, res)) return;
  res.writeHead(404);
  res.end();
});
console.log('Servidor HTTP configurado (Coolify gerenciará HTTPS)');

// Configuração do CORS: lista explícita + em desenvolvimento aceita qualquer origem (LAN no telemóvel).
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://192.168.3.16:3000',
      'http://192.168.3.16:4000',
      'http://192.168.1.100:3000',
      'http://192.168.1.101:3000',
      'http://10.0.0.1:3000',
      'http://172.16.0.1:3000',
      'http://medias.confissoesdecorno.com',
      'https://confissoesdecorno.com',
      'https://socket.confissoesdecorno.com',
      'http://medias.confissoesdecorno.com',
    ];

function socketCorsOrigin(origin, callback) {
  if (!origin) {
    callback(null, true);
    return;
  }
  if (corsOrigins.includes(origin)) {
    callback(null, true);
    return;
  }
  if (NODE_ENV !== 'production') {
    callback(null, true);
    return;
  }
  callback(new Error('Not allowed by CORS'));
}

const io = socketIo(server, {
  cors: {
    origin: socketCorsOrigin,
    methods: ['GET', 'POST'],
    credentials: true
  },
  // Configurações para lidar com proxies e timeouts
  serveClient: false, // Não servir o cliente socket.io do servidor
  transports: ['websocket'], // Forçar o uso de WebSockets
  pingTimeout: 60000, // Aumentar o tempo limite do ping para 60 segundos
  pingInterval: 25000, // Enviar ping a cada 25 segundos
  path: '/socket.io', // Caminho explícito para o socket.io
});

const prisma = new PrismaClient();

// Teste de conexão do Prisma
async function testPrismaConnection() {
  try {
    console.log('🔍 Testando conexão com o banco de dados...');
    const userCount = await prisma.user.count();
    console.log(`✅ Conexão com banco OK! Total de usuários: ${userCount}`);
  } catch (error) {
    console.error('❌ Erro na conexão com banco de dados:', error);
    process.exit(1);
  }
}

// Executar teste de conexão
testPrismaConnection();

let connectedUsers = [];
let roomUsers = new Map(); // Mapeia roomId -> Set de socketIds

// Função para enviar notificação em tempo real
const sendNotification = (userId, notification) => {
  console.log(`🔍 Tentando enviar notificação para userId: ${userId}`);
  console.log(`📋 Usuários conectados:`, connectedUsers.map(u => ({ userId: u.userId, username: u.username })));
  
  const userSocket = connectedUsers.find(user => user.userId === userId);
  if (userSocket) {
    console.log(`✅ Usuário ${userSocket.username} (${userId}) encontrado, enviando notificação...`);
    io.to(userSocket.socketId).emit('notification', notification);
    console.log(`📢 Notificação enviada para ${userId}:`, notification.title);
  } else {
    console.log(`❌ Usuário ${userId} não está conectado. Usuários conectados:`, connectedUsers.map(u => u.userId));
  }
};

io.on('connection', (socket) => {
  console.log('Conexão WebSocket estabelecida:', socket.id);
  anonymousSockets.add(socket.id);

  socket.on('authenticate', async (data) => {
    anonymousSockets.delete(socket.id);

    const { userId } = data;
    
    console.log('🔐 Tentativa de autenticação para userId:', userId);

    const userExists = connectedUsers.some((user) => user.userId === userId);
    if (!userExists) {
      try {
        console.log('🔍 Buscando usuário no banco com ID:', userId);
        
        // Tentar buscar por ID primeiro
        let user = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            username: true,
            image: true,
            city: true,
            premium: true,
            followers: {
              select: {
                id: true
              }
            }
          },
        });

        // Se não encontrar por ID, tentar por email (caso o userId seja um email)
        if (!user) {
          console.log('🔍 Usuário não encontrado por ID, tentando por email...');
          user = await prisma.user.findUnique({
            where: { email: userId },
            select: {
              id: true,
              username: true,
              image: true,
              city: true,
              premium: true,
              followers: {
                select: {
                  id: true
                }
              }
            },
          });
        }

        console.log('🔍 Resultado da busca:', user);

        if (user) {
          // Atualizar lastSeen no banco de dados
          try {
            await prisma.$runCommandRaw({
              update: "users",
              updates: [{
                q: { _id: { $oid: userId } },
                u: { $set: { lastSeen: { $date: new Date().toISOString() } } }
              }]
            });
            console.log(`📅 LastSeen atualizado para usuário ${user.username}`);
          } catch (error) {
            console.error('❌ Erro ao atualizar lastSeen:', error);
          }

          connectedUsers.push({
            socketId: socket.id,
            userId,
            ...user,
            connectedAt: new Date(),
          });

          /* Sala por userId — necessário para io.to(receiverId).emit em mensagens diretas */
          socket.join(user.id);

          console.log(`✅ Usuário ${user.username} autenticado. Total de usuários conectados: ${connectedUsers.length}`);

          // Enviar lista atualizada para todos os clientes
          const usersToSend = connectedUsers.map((connectedUser) => ({
            id: connectedUser.userId,
            username: connectedUser.username,
            image: connectedUser.image,
            city: connectedUser.city,
            socketId: connectedUser.socketId,
            followersCount: connectedUser.followers?.length || 0,
            connectedAt: connectedUser.connectedAt?.toISOString(),
          }));

          console.log('📤 Estrutura dos dados enviados:', usersToSend.map(u => ({
            id: u.id,
            username: u.username,
            idType: typeof u.id,
            idLength: u.id?.length
          })));

          console.log('📤 Enviando lista de usuários para todos os clientes:', usersToSend.length, 'usuários');
          console.log('📋 Usuários:', usersToSend.map(u => u.username));

          io.emit('update_connected_users', usersToSend);
          
          // Função para enviar usuários de uma sala específica
          const sendRoomUsers = (roomId) => {
            if (!roomUsers.has(roomId)) return;
            
            const roomSocketIds = roomUsers.get(roomId);
            const roomConnectedUsers = connectedUsers.filter(user => 
              roomSocketIds.has(user.socketId)
            );
            
            const roomUsersToSend = roomConnectedUsers.map((user) => ({
              id: user.userId,
              username: user.username,
              image: user.image,
              city: user.city,
              socketId: user.socketId,
              followersCount: user.followers?.length || 0,
              connectedAt: user.connectedAt?.toISOString(),
            }));
            
            console.log(`📤 Enviando usuários da sala ${roomId}:`, roomUsersToSend.length, 'usuários');
            io.to(roomId).emit('update_room_users', roomUsersToSend);
          };
          
          // Enviar para todas as salas existentes
          roomUsers.forEach((_, roomId) => {
            sendRoomUsers(roomId);
          });
        } else {
          console.log('❌ Usuário não encontrado no banco de dados para userId:', userId);
          socket.emit('error', { message: 'Usuário não encontrado.' });
        }
      } catch (error) {
        console.error('Erro ao buscar dados do usuário:', error);
        socket.emit('error', { message: 'Erro ao autenticar usuário.' });
      }
    }
  });

  socket.on('join_room', (roomId) => {
    socket.join(roomId);
    console.log(`Usuário ${socket.id} entrou na sala ${roomId}`);
    
    // Adicionar usuário à sala
    if (!roomUsers.has(roomId)) {
      roomUsers.set(roomId, new Set());
    }
    roomUsers.get(roomId).add(socket.id);
    
    // Enviar lista de usuários da sala para todos na sala
    const roomSocketIds = roomUsers.get(roomId);
    const roomConnectedUsers = connectedUsers.filter(user => 
      roomSocketIds.has(user.socketId)
    );
    
    const roomUsersToSend = roomConnectedUsers.map((user) => ({
      id: user.userId,
      username: user.username,
      image: user.image,
      city: user.city,
      socketId: user.socketId,
      followersCount: user.followers?.length || 0,
      connectedAt: user.connectedAt?.toISOString(),
    }));
    
    console.log(`📤 Enviando usuários da sala ${roomId}:`, roomUsersToSend.length, 'usuários');
    io.to(roomId).emit('update_room_users', roomUsersToSend);
  });

  socket.on('leave_room', (roomId) => {
    socket.leave(roomId);
    console.log(`Usuário ${socket.id} saiu da sala ${roomId}`);
    
    // Remover usuário da sala
    if (roomUsers.has(roomId)) {
      roomUsers.get(roomId).delete(socket.id);
      
      // Se a sala ficou vazia, remover do Map
      if (roomUsers.get(roomId).size === 0) {
        roomUsers.delete(roomId);
      } else {
        // Enviar lista atualizada para os usuários restantes na sala
        const roomSocketIds = roomUsers.get(roomId);
        const roomConnectedUsers = connectedUsers.filter(user => 
          roomSocketIds.has(user.socketId)
        );
        
        const roomUsersToSend = roomConnectedUsers.map((user) => ({
          id: user.userId,
          username: user.username,
          image: user.image,
          city: user.city,
          socketId: user.socketId,
          followersCount: user.followers?.length || 0,
          connectedAt: user.connectedAt?.toISOString(),
        }));
        
        console.log(`📤 Enviando usuários da sala ${roomId} (após saída):`, roomUsersToSend.length, 'usuários');
        io.to(roomId).emit('update_room_users', roomUsersToSend);
      }
    }
  });

  socket.on('typing', (data) => {
    const { userId, roomId, isTyping } = data;
    console.log(`Usuário ${userId} ${isTyping ? 'está digitando' : 'parou de digitar'} na sala ${roomId}`);
    
    // Buscar username do usuário
    const user = connectedUsers.find(u => u.userId === userId);
    if (user) {
      socket.to(roomId).emit('user_typing', {
        userId,
        username: user.username,
        isTyping
      });
    }
  });

  socket.on('send_public_message', async (data) => {
    console.log('Mensagem pública recebida:', data);
    const { senderId, roomId, content } = data;

    try {
      const savedMessage = await prisma.chatMessage.create({
        data: {
          senderId,
          roomId,
          content,
          timestamp: new Date(),
        },
        include: {
          sender: true,
        },
      });

      io.to(roomId).emit('receive_public_message', savedMessage);
    } catch (error) {
      console.error('Erro ao salvar mensagem pública no banco de dados:', error);
      socket.emit('error', { message: 'Falha ao enviar mensagem pública.' });
    }
  });

  // Eventos de notificação
  socket.on('create_follow_notification', async (data) => {
    console.log('🔔 Evento create_follow_notification recebido:', data);
    const { followerId, followingId } = data;
    
    try {
      console.log('🔍 Buscando usuário seguidor:', followerId);
      const follower = await prisma.user.findUnique({
        where: { id: followerId },
        select: { username: true, image: true },
      });

      if (!follower) {
        console.log('❌ Usuário seguidor não encontrado:', followerId);
        socket.emit('error', { message: 'Usuário seguidor não encontrado.' });
        return;
      }

      console.log('✅ Usuário seguidor encontrado:', follower.username);
      console.log('📝 Criando notificação para usuário:', followingId);

      const notification = await prisma.notification.create({
        data: {
          userId: followingId,
          type: 'follow',
          title: 'Novo seguidor!',
          message: `${follower.username} começou a seguir você`,
          data: { followerId },
          read: false,
        },
      });

      console.log('✅ Notificação criada com sucesso:', notification.id);
      sendNotification(followingId, notification);
    } catch (error) {
      console.error('❌ Erro ao criar notificação de follow:', error);
      console.error('Stack trace:', error.stack);
      socket.emit('error', { message: 'Falha ao criar notificação.' });
    }
  });

  // Evento genérico de notificação
  socket.on('notification', async (data) => {
    console.log('🔔 Evento notification recebido:', data);
    console.log('🔌 Socket ID do evento:', socket.id);
    console.log('📋 Usuários conectados:', connectedUsers.map(u => ({ userId: u.userId, username: u.username, socketId: u.socketId })));
    
    const { type, postId, postOwnerId, postDescription, commentContent, followerId, followingId, commentId, replyId } = data;
    
    try {
      // Buscar dados do usuário que está executando a ação
      const currentUser = connectedUsers.find(user => user.socketId === socket.id);
      if (!currentUser) {
        console.log('❌ Usuário não encontrado na lista de conectados');
        console.log('🔍 Socket ID procurado:', socket.id);
        console.log('📋 Socket IDs disponíveis:', connectedUsers.map(u => u.socketId));
        return;
      }

      const actorId = currentUser.userId;
      console.log('🔍 Usuário executando ação:', actorId);
      console.log('🔍 Dados do usuário:', { userId: currentUser.userId, username: currentUser.username, socketId: currentUser.socketId });

      switch (type) {
        case 'like':
          if (!postId || !postOwnerId) {
            console.log('❌ Dados insuficientes para notificação de curtida');
            return;
          }

          // Não criar notificação se o usuário curtir seu próprio post
          if (actorId === postOwnerId) {
            console.log('⏭️ Usuário curtindo próprio post, ignorando...');
            return;
          }

          const liker = await prisma.user.findUnique({
            where: { id: actorId },
            select: { username: true, image: true },
          });

          if (!liker) {
            console.log('❌ Usuário que curtiu não encontrado:', actorId);
            return;
          }

          console.log('📝 Criando notificação de curtida para usuário:', postOwnerId);
          console.log('📝 Dados da notificação:', {
            userId: postOwnerId,
            type: 'like',
            title: 'Nova curtida!',
            message: `${liker.username} curtiu seu post`,
            data: { postId, postDescription },
            read: false,
          });
          
          try {
            const likeNotification = await prisma.notification.create({
              data: {
                userId: postOwnerId,
                type: 'like',
                title: 'Nova curtida!',
                message: `${liker.username} curtiu seu post`,
                data: { postId, postDescription },
                read: false,
              },
            });

            console.log('✅ Notificação de curtida criada:', likeNotification.id);
            console.log('✅ Dados da notificação criada:', likeNotification);
            sendNotification(postOwnerId, likeNotification);
          } catch (prismaError) {
            console.error('❌ Erro ao criar notificação no banco:', prismaError);
            console.error('❌ Detalhes do erro:', {
              message: prismaError.message,
              code: prismaError.code,
              meta: prismaError.meta,
            });
            throw prismaError;
          }
          break;

        case 'comment':
          if (!postId || !postOwnerId) {
            console.log('❌ Dados insuficientes para notificação de comentário');
            return;
          }

          // Não criar notificação se o usuário comentar seu próprio post
          if (actorId === postOwnerId) {
            console.log('⏭️ Usuário comentando próprio post, ignorando...');
            return;
          }

          const commenter = await prisma.user.findUnique({
            where: { id: actorId },
            select: { username: true, image: true },
          });

          if (!commenter) {
            console.log('❌ Usuário que comentou não encontrado:', actorId);
            return;
          }

          console.log('📝 Criando notificação de comentário para usuário:', postOwnerId);
          const commentNotification = await prisma.notification.create({
            data: {
              userId: postOwnerId,
              type: 'comment',
              title: 'Novo comentário!',
              message: `${commenter.username} comentou: "${commentContent}"`,
              data: { postId, commentContent },
              read: false,
            },
          });

          console.log('✅ Notificação de comentário criada:', commentNotification.id);
          sendNotification(postOwnerId, commentNotification);
          break;

        case 'follow':
          if (!followerId || !followingId) {
            console.log('❌ Dados insuficientes para notificação de follow');
            return;
          }

          const follower = await prisma.user.findUnique({
            where: { id: followerId },
            select: { username: true, image: true },
          });

          if (!follower) {
            console.log('❌ Usuário seguidor não encontrado:', followerId);
            return;
          }

          console.log('📝 Criando notificação de follow para usuário:', followingId);
          const followNotification = await prisma.notification.create({
            data: {
              userId: followingId,
              type: 'follow',
              title: 'Novo seguidor!',
              message: `${follower.username} começou a seguir você`,
              data: { followerId },
              read: false,
            },
          });

          console.log('✅ Notificação de follow criada:', followNotification.id);
          sendNotification(followingId, followNotification);
          break;

        case 'comment_like':
          if (!postId || !commentId) {
            console.log('❌ Dados insuficientes para notificação de curtida em comentário');
            return;
          }

          // Buscar o comentário para obter o autor
          const comment = await prisma.comment.findUnique({
            where: { id: commentId },
            select: { userId: true, content: true },
          });

          if (!comment) {
            console.log('❌ Comentário não encontrado:', commentId);
            return;
          }

          // Não criar notificação se o usuário curtir seu próprio comentário
          if (actorId === comment.userId) {
            console.log('⏭️ Usuário curtindo próprio comentário, ignorando...');
            return;
          }

          const commentLiker = await prisma.user.findUnique({
            where: { id: actorId },
            select: { username: true, image: true },
          });

          if (!commentLiker) {
            console.log('❌ Usuário que curtiu comentário não encontrado:', actorId);
            return;
          }

          // Truncar o conteúdo do comentário para a mensagem
          const commentPreview = comment.content.length > 50 
            ? comment.content.substring(0, 50) + '...' 
            : comment.content;

          console.log('📝 Criando notificação de curtida em comentário para usuário:', comment.userId);
          const commentLikeNotification = await prisma.notification.create({
            data: {
              userId: comment.userId,
              type: 'like',
              title: 'Nova curtida no comentário!',
              message: `${commentLiker.username} curtiu seu comentário: "${commentPreview}"`,
              data: { postId, commentId },
              read: false,
            },
          });

          console.log('✅ Notificação de curtida em comentário criada:', commentLikeNotification.id);
          sendNotification(comment.userId, commentLikeNotification);
          break;

        case 'comment_reply':
          if (!postId || !commentId || !replyId) {
            console.log('❌ Dados insuficientes para notificação de resposta a comentário');
            return;
          }

          // Buscar o comentário pai para obter o autor
          const parentComment = await prisma.comment.findUnique({
            where: { id: commentId },
            select: { userId: true, content: true },
          });

          if (!parentComment) {
            console.log('❌ Comentário pai não encontrado:', commentId);
            return;
          }

          // Não criar notificação se o usuário responder seu próprio comentário
          if (actorId === parentComment.userId) {
            console.log('⏭️ Usuário respondendo próprio comentário, ignorando...');
            return;
          }

          const replier = await prisma.user.findUnique({
            where: { id: actorId },
            select: { username: true, image: true },
          });

          if (!replier) {
            console.log('❌ Usuário que respondeu não encontrado:', actorId);
            return;
          }

          // Truncar o conteúdo do comentário para a mensagem
          const parentCommentPreview = parentComment.content.length > 50 
            ? parentComment.content.substring(0, 50) + '...' 
            : parentComment.content;

          console.log('📝 Criando notificação de resposta a comentário para usuário:', parentComment.userId);
          const commentReplyNotification = await prisma.notification.create({
            data: {
              userId: parentComment.userId,
              type: 'comment',
              title: 'Nova resposta ao seu comentário!',
              message: `${replier.username} respondeu seu comentário: "${parentCommentPreview}"`,
              data: { postId, commentId: replyId },
              read: false,
            },
          });

          console.log('✅ Notificação de resposta a comentário criada:', commentReplyNotification.id);
          sendNotification(parentComment.userId, commentReplyNotification);
          break;

        default:
          console.log('❌ Tipo de notificação não reconhecido:', type);
      }
    } catch (error) {
      console.error('❌ Erro ao processar notificação:', error);
      console.error('❌ Detalhes do erro:', {
        message: error.message,
        name: error.name,
        code: error.code,
        meta: error.meta,
      });
      console.error('❌ Stack trace:', error.stack);
    }
  });

  socket.on('create_like_notification', async (data) => {
    console.log('🔔 Evento create_like_notification recebido:', data);
    const { likerId, postId } = data;
    
    try {
      console.log('🔍 Buscando usuário que curtiu:', likerId);
      const liker = await prisma.user.findUnique({
        where: { id: likerId },
        select: { username: true, image: true },
      });

      console.log('🔍 Buscando post:', postId);
      const post = await prisma.post.findUnique({
        where: { id: postId },
        select: { userId: true },
      });

      if (!liker || !post) {
        console.log('❌ Usuário ou post não encontrado. Liker:', !!liker, 'Post:', !!post);
        socket.emit('error', { message: 'Usuário ou post não encontrado.' });
        return;
      }

      console.log('✅ Usuário e post encontrados. Liker:', liker.username, 'Post owner:', post.userId);

      // Não criar notificação se o usuário curtir seu próprio post
      if (likerId === post.userId) {
        console.log('⏭️ Usuário curtindo próprio post, ignorando...');
        return;
      }

      console.log('📝 Criando notificação de curtida para usuário:', post.userId);
      const notification = await prisma.notification.create({
        data: {
          userId: post.userId,
          type: 'like',
          title: 'Nova curtida!',
          message: `${liker.username} curtiu seu post`,
          data: { postId },
          read: false,
        },
      });

      console.log('✅ Notificação de curtida criada com sucesso:', notification.id);
      sendNotification(post.userId, notification);
    } catch (error) {
      console.error('❌ Erro ao criar notificação de curtida:', error);
      console.error('Stack trace:', error.stack);
      socket.emit('error', { message: 'Falha ao criar notificação.' });
    }
  });

  socket.on('create_comment_notification', async (data) => {
    console.log('🔔 Evento create_comment_notification recebido:', data);
    const { commenterId, postId, commentId } = data;
    
    try {
      console.log('🔍 Buscando usuário que comentou:', commenterId);
      const commenter = await prisma.user.findUnique({
        where: { id: commenterId },
        select: { username: true, image: true },
      });

      console.log('🔍 Buscando post:', postId);
      const post = await prisma.post.findUnique({
        where: { id: postId },
        select: { userId: true },
      });

      if (!commenter || !post) {
        console.log('❌ Usuário ou post não encontrado. Commenter:', !!commenter, 'Post:', !!post);
        socket.emit('error', { message: 'Usuário ou post não encontrado.' });
        return;
      }

      console.log('✅ Usuário e post encontrados. Commenter:', commenter.username, 'Post owner:', post.userId);

      // Não criar notificação se o usuário comentar seu próprio post
      if (commenterId === post.userId) {
        console.log('⏭️ Usuário comentando próprio post, ignorando...');
        return;
      }

      console.log('📝 Criando notificação de comentário para usuário:', post.userId);
      const notification = await prisma.notification.create({
        data: {
          userId: post.userId,
          type: 'comment',
          title: 'Novo comentário!',
          message: `${commenter.username} comentou seu post`,
          data: { postId, commentId },
          read: false,
        },
      });

      console.log('✅ Notificação de comentário criada com sucesso:', notification.id);
      sendNotification(post.userId, notification);
    } catch (error) {
      console.error('❌ Erro ao criar notificação de comentário:', error);
      console.error('Stack trace:', error.stack);
      socket.emit('error', { message: 'Falha ao criar notificação.' });
    }
  });

  socket.on('send_message', async (data) => {
    console.log('Mensagem privada recebida:', data);
    const { senderId, receiverId, content, medias, timestamp } = data;

    try {
      // Verificar se o remetente existe e se é premium
      const sender = await prisma.user.findUnique({
        where: { id: senderId },
        select: { premium: true },
      });

      if (!sender) {
        socket.emit('error', { message: 'Usuário remetente não encontrado.' });
        return;
      }

      const dmPolicy = await getDirectMessagesPolicy();

      if (dmPolicy === 'premium_only') {
        // Se o remetente não é premium, verificar se o destinatário é premium
        // e se ele já enviou uma mensagem para o remetente
        if (!sender.premium) {
          const receiver = await prisma.user.findUnique({
            where: { id: receiverId },
            select: { premium: true },
          });

          if (!receiver) {
            socket.emit('error', { message: 'Usuário destinatário não encontrado.' });
            return;
          }

          if (!receiver.premium) {
            socket.emit('error', {
              message: 'Apenas usuários premium podem iniciar mensagens diretas.',
            });
            return;
          }

          // Verificar se o destinatário (premium) já enviou uma mensagem para o remetente
          const existingMessage = await prisma.message.findFirst({
            where: {
              senderId: receiverId,
              receiverId: senderId,
            },
          });

          if (!existingMessage) {
            socket.emit('error', {
              message: 'Apenas usuários premium podem iniciar mensagens diretas.',
            });
            return;
          }
        }
      } else {
        const receiver = await prisma.user.findUnique({
          where: { id: receiverId },
          select: { id: true },
        });
        if (!receiver) {
          socket.emit('error', { message: 'Usuário destinatário não encontrado.' });
          return;
        }
      }

      // Salvar a mensagem no banco de dados
      const savedMessage = await prisma.message.create({
        data: {
          senderId,
          receiverId,
          content,
          medias: medias || [],
          timestamp: new Date(timestamp),
        },
      });

      // Enviar a mensagem para o remetente e o destinatário
      io.to(senderId).emit('receive_message', savedMessage);
      io.to(receiverId).emit('receive_message', savedMessage);
    } catch (error) {
      console.error('Erro ao salvar mensagem privada no banco de dados:', error);
      socket.emit('error', { message: 'Falha ao enviar mensagem privada.' });
    }
  });

  socket.on('disconnect', () => {
    console.log('Usuário desconectado:', socket.id);
    anonymousSockets.delete(socket.id);

    // Remover usuário da lista de conectados
    const disconnectedUser = connectedUsers.find(user => user.socketId === socket.id);
    connectedUsers = connectedUsers.filter((user) => user.socketId !== socket.id);

    // Atualizar lastSeen no banco de dados
    if (disconnectedUser) {
      try {
        prisma.$runCommandRaw({
          update: "users",
          updates: [{
            q: { _id: { $oid: disconnectedUser.userId } },
            u: { $set: { lastSeen: { $date: new Date().toISOString() } } }
          }]
        }).then(() => {
          console.log(`📅 LastSeen atualizado para usuário ${disconnectedUser.username} (desconectado)`);
        }).catch((error) => {
          console.error('❌ Erro ao atualizar lastSeen na desconexão:', error);
        });
      } catch (error) {
        console.error('❌ Erro ao atualizar lastSeen na desconexão:', error);
      }
    }

    console.log(`Usuários conectados após desconexão: ${connectedUsers.length}`);

    // Remover usuário de todas as salas
    roomUsers.forEach((socketIds, roomId) => {
      if (socketIds.has(socket.id)) {
        socketIds.delete(socket.id);
        
        // Se a sala ficou vazia, remover do Map
        if (socketIds.size === 0) {
          roomUsers.delete(roomId);
        } else {
          // Enviar lista atualizada para os usuários restantes na sala
          const roomConnectedUsers = connectedUsers.filter(user => 
            socketIds.has(user.socketId)
          );
          
          const roomUsersToSend = roomConnectedUsers.map((user) => ({
            id: user.userId,
            username: user.username,
            image: user.image,
            city: user.city,
            socketId: user.socketId,
            followersCount: user.followers?.length || 0,
            connectedAt: user.connectedAt?.toISOString(),
          }));
          
          console.log(`📤 Enviando usuários da sala ${roomId} (após desconexão):`, roomUsersToSend.length, 'usuários');
          io.to(roomId).emit('update_room_users', roomUsersToSend);
        }
      }
    });

    // Enviar lista atualizada para todos os clientes
    const usersToSend = connectedUsers.map((user) => ({
      id: user.userId,
      username: user.username,
      image: user.image,
      city: user.city,
      socketId: user.socketId,
      followersCount: user.followers?.length || 0,
      connectedAt: user.connectedAt?.toISOString(),
    }));

    io.emit('update_connected_users', usersToSend);
    
    if (disconnectedUser) {
      console.log(`Usuário ${disconnectedUser.username} desconectado`);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor WebSocket rodando na porta ${PORT} em modo ${NODE_ENV}`);
  console.log(`CORS configurado para: ${corsOrigins.join(', ')}`);
});

// Encerrar o cliente Prisma ao fechar o servidor
process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  server.close(() => {
    console.log('Servidor WebSocket encerrado.');
    process.exit(0);
  });
});

// Tratamento de erros não capturados
process.on('uncaughtException', (error) => {
  console.error('Erro não capturado:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promise rejeitada não tratada:', reason);
  process.exit(1);
});