#include "msgqueue.h"
#include <stdlib.h>
#include <string.h>

void msgq_init(msg_queue *q, size_t max_bytes)
{
    pthread_mutex_init(&q->lock, NULL);
    q->head = q->tail = NULL;
    q->count = 0;
    q->bytes = 0;
    q->max_bytes = max_bytes;
    q->dropped = 0;
}

void msgq_destroy(msg_queue *q)
{
    msg_node *n = q->head;
    while (n)
    {
        msg_node *nx = n->next;
        free(n->data);
        free(n);
        n = nx;
    }
    pthread_mutex_destroy(&q->lock);
}

/* 从队头丢弃 droppable 消息，直到剩余字节 <= max_bytes（或队空）。
 * 调用方需持有 q->lock。返回丢弃条数。 */
static int msgq_drop_oldest(msg_queue *q, size_t max_bytes)
{
    int dropped = 0;
    while (q->bytes > max_bytes && q->head && q->head->droppable)
    {
        msg_node *n = q->head;
        q->head = n->next;
        if (!q->head)
            q->tail = NULL;
        q->bytes -= n->len;
        q->count--;
        dropped++;
        free(n->data);
        free(n);
    }
    return dropped;
}

void msgq_set_budget(msg_queue *q, size_t max_bytes)
{
    pthread_mutex_lock(&q->lock);
    q->max_bytes = max_bytes;
    /* 收缩预算时立即丢弃超出的可丢帧 */
    q->dropped += msgq_drop_oldest(q, q->max_bytes);
    pthread_mutex_unlock(&q->lock);
}

int msgq_push_take(msg_queue *q, uint8_t *data, size_t len, int droppable)
{
    pthread_mutex_lock(&q->lock);
    /* 超出预算：丢弃最旧的 droppable 消息（保持低延迟） */
    size_t target = len >= q->max_bytes ? 0 : q->max_bytes - len;
    q->dropped += msgq_drop_oldest(q, target);
    msg_node *n = malloc(sizeof *n);
    if (!n)
    {
        pthread_mutex_unlock(&q->lock);
        return 0;
    }
    n->next = NULL;
    n->len = len;
    n->droppable = droppable;
    n->data = data;
    if (q->tail)
        q->tail->next = n;
    else
        q->head = n;
    q->tail = n;
    q->count++;
    q->bytes += len;
    pthread_mutex_unlock(&q->lock);
    return 1;
}

int msgq_push(msg_queue *q, const uint8_t *data, size_t len, int droppable)
{
    uint8_t *copy = malloc(len > 0 ? len : 1);
    if (!copy)
        return 0;
    memcpy(copy, data, len);
    if (!msgq_push_take(q, copy, len, droppable))
    {
        free(copy);
        return 0;
    }
    return 1;
}

msg_node *msgq_pop(msg_queue *q)
{
    pthread_mutex_lock(&q->lock);
    msg_node *n = q->head;
    if (n)
    {
        q->head = n->next;
        if (!q->head)
            q->tail = NULL;
        q->bytes -= n->len;
        q->count--;
    }
    pthread_mutex_unlock(&q->lock);
    return n;
}
