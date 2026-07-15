package nz.scuttlebutt.tremola.ssb.db.daos

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import nz.scuttlebutt.tremola.ssb.db.entities.BoardOperation

@Dao
interface BoardOperationDAO {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insert(operation: BoardOperation): Long

    @Query(
        "SELECT * FROM BoardOperation WHERE room_id = :roomId " +
            "AND operation_id = :operationId LIMIT 1"
    )
    fun getById(roomId: String, operationId: String): BoardOperation?

    @Query(
        "SELECT * FROM BoardOperation WHERE room_id = :roomId " +
            "ORDER BY received_at ASC, operation_id ASC"
    )
    fun getRoomOperations(roomId: String): List<BoardOperation>

    @Query(
        "SELECT * FROM BoardOperation WHERE room_id = :roomId AND author_id = :authorId " +
            "AND author_seq BETWEEN :fromSequence AND :toSequence " +
            "ORDER BY author_seq ASC LIMIT :limit"
    )
    fun getRange(
        roomId: String,
        authorId: String,
        fromSequence: Int,
        toSequence: Int,
        limit: Int
    ): List<BoardOperation>

    @Query(
        "SELECT * FROM BoardOperation WHERE room_id = :roomId " +
            "ORDER BY author_id ASC, author_seq ASC"
    )
    fun getRoomSequences(roomId: String): List<BoardOperation>

    @Query(
        "SELECT MAX(author_seq) FROM BoardOperation " +
            "WHERE room_id = :roomId AND author_id = :authorId"
    )
    fun getMaxSequence(roomId: String, authorId: String): Int?

    @Query("DELETE FROM BoardOperation WHERE room_id = :roomId")
    fun deleteRoom(roomId: String)
}
