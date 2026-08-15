#pragma once
#include <stddef.h>
#include <stdint.h>
#include <pthread.h>

/* 出站消息队列：抓帧线程（生产者） -> 事件循环（消费者） */
typedef struct msg_node
{
    struct msg_node *next;
    size_t len;
    int droppable; /* 视频帧可丢弃，配置/登录结果不可丢 */
    uint8_t data[];
} msg_node;

typedef struct msg_queue
{
    pthread_mutex_t lock;
    msg_node *head;
    msg_node *tail;
    size_t count;
    size_t bytes;
    size_t max_bytes;
    uint64_t dropped;
} msg_queue;

void msgq_init(msg_queue *q, size_t max_bytes);
void msgq_destroy(msg_queue *q);
/* 推入消息；超过预算时丢弃最旧的 droppable 消息。返回 1。 */
int msgq_push(msg_queue *q, const uint8_t *data, size_t len, int droppable);
/* 取出队首（无则返回 NULL），调用者负责 free(node)。 */
msg_node *msgq_pop(msg_queue *q);
