/* 单元测试：出站消息队列（FIFO 顺序 / 预算丢帧 / 非丢帧保护） */
#include "../src/msgqueue.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int g_failures = 0;
#define CHECK(cond)                                                        \
    do                                                                     \
    {                                                                      \
        if (!(cond))                                                       \
        {                                                                  \
            fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            g_failures++;                                                  \
        }                                                                  \
    } while (0)

static void free_node(msg_node *n)
{
    if (!n)
        return;
    free(n->data);
    free(n);
}

static void test_fifo(void)
{
    msg_queue q;
    msgq_init(&q, 1024);
    const uint8_t a[] = {1, 2, 3}, b[] = {4, 5};

    CHECK(msgq_push(&q, a, sizeof a, 0) == 1);
    CHECK(msgq_push(&q, b, sizeof b, 0) == 1);
    CHECK(q.count == 2 && q.bytes == 5);

    msg_node *n = msgq_pop(&q);
    CHECK(n && n->len == 3 && n->data[0] == 1 && n->data[2] == 3);
    free_node(n);
    n = msgq_pop(&q);
    CHECK(n && n->len == 2 && n->data[0] == 4);
    free_node(n);
    CHECK(msgq_pop(&q) == NULL);
    CHECK(q.count == 0);

    msgq_destroy(&q);
}

static void test_drop_oldest(void)
{
    msg_queue q;
    msgq_init(&q, 1024);
    const uint8_t d[4] = {0};

    /* 超出预算：丢弃最旧的 droppable 帧 */
    msgq_set_budget(&q, 4);
    msgq_push(&q, d, 3, 1);
    msgq_push(&q, d, 3, 1);
    CHECK(q.count == 1 && q.bytes == 3 && q.dropped == 1);
    msg_node *n = msgq_pop(&q);
    CHECK(n && n->len == 3);
    free_node(n);

    /* 队头非 droppable 时不能丢，入队后超出预算但不丢关键消息 */
    msgq_set_budget(&q, 4);
    msgq_push(&q, d, 3, 0);
    msgq_push(&q, d, 3, 1);
    CHECK(q.count == 2 && q.bytes == 6 && q.dropped == 1);
    n = msgq_pop(&q);
    CHECK(n && n->droppable == 0);
    free_node(n);
    n = msgq_pop(&q);
    CHECK(n && n->droppable == 1);
    free_node(n);

    /* 收缩预算立即丢帧 */
    msgq_set_budget(&q, 100);
    for (int i = 0; i < 4; i++)
        msgq_push(&q, d, 10, 1);
    CHECK(q.bytes == 40);
    msgq_set_budget(&q, 25);
    CHECK(q.count == 2 && q.bytes == 20);

    msgq_destroy(&q);
}

int main(void)
{
    test_fifo();
    test_drop_oldest();
    if (g_failures)
    {
        fprintf(stderr, "test_msgq: %d failure(s)\n", g_failures);
        return 1;
    }
    printf("test_msgq: ok\n");
    return 0;
}
